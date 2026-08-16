//Vi börjar med att importera våra moduler
/* Själva serverklassen. Den hanterar MCP-protokollet – tar emot anrop från en klient (t.ex│
Claude Desktop) och låter dig registrera "tools"*/ 
import {McpServer} from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from "@aws-sdk/client-ec2";
import { CloudWatchClient, GetMetricStatisticsCommand } from "@aws-sdk/client-cloudwatch"; 
import { z } from "zod";

class AwsMcpOptimizerServer {
    private server: McpServer;
    private ec2Client: EC2Client;
    private cwClient: CloudWatchClient;

    constructor() {                                                                                                        
      this.server = new McpServer({                                                                                      
        name: "aws-mcp-optimizer",
        version: "1.0.0",
      });
      this.ec2Client = new EC2Client({ region: "eu-north-1" });
      this.cwClient = new CloudWatchClient({ region: "eu-north-1" });   
      this.registerTools();                                                   
    }

    private registerTools(): void {
      this.server.tool(
      "list_ec2_instances",
      "Listar alla EC2-instanser i regionen med deras ID, typ och status",
      {},
      async () => {
        try {
          const command = new DescribeInstancesCommand({});
          const response = await this.ec2Client.send(command);
          const instances = response.Reservations?.flatMap(
            (r) => r.Instances ?? []
          );
          const result = instances?.map((i) => ({
            id: i.InstanceId,
            type: i.InstanceType,
            state: i.State?.Name,
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Fel vid hämtning av EC2-instanser: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
    );
    
    this.server.tool(
      "get_cpu_statistics",
      "Hämtar genomsnittlig CPU-användning för en EC2-instans de senaste 24 timmarna",
      {
        instanceId: z.string().describe("EC2-instansens ID, t.ex. i-1234567890abcdef0"),
      },
      async ({ instanceId }) => {
        try {
          const now = new Date();
          const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

          const command = new GetMetricStatisticsCommand({
            Namespace: "AWS/EC2",
            MetricName: "CPUUtilization",
            Dimensions: [{ Name: "InstanceId", Value: instanceId }],
            StartTime: yesterday,
            EndTime: now,
            Period: 3600,
            Statistics: ["Average"],
          });

          const response = await this.cwClient.send(command);

          return {
            content: [{
              type: "text",
              text: JSON.stringify(response.Datapoints, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Fel vid hämtning av CPU-statistik: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
    );

    this.server.tool(
      "analyze_underutilized_instances",
      "Analyserar alla EC2-instanser och identifierar underutnyttjade resurser baserat på CPU-användning",
      {},
      async () => {
        try {
          const ec2Command = new DescribeInstancesCommand({});
          const ec2Response = await this.ec2Client.send(ec2Command);
          const instances = ec2Response.Reservations?.flatMap(
            (r) => r.Instances ?? []
          ) ?? [];

          const recommendations: string[] = [];

          for (const instance of instances) {
            const instanceId = instance.InstanceId ?? "okänt";
            const instanceType = instance.InstanceType ?? "okänd";

            const now = new Date();
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

            const command = new GetMetricStatisticsCommand({
              Namespace: "AWS/EC2",
              MetricName: "CPUUtilization",
              Dimensions: [{ Name: "InstanceId", Value: instanceId }],
              StartTime: yesterday,
              EndTime: now,
              Period: 3600,
              Statistics: ["Average"],
            });

            const cwResponse = await this.cwClient.send(command);
            const datapoints = cwResponse.Datapoints ?? [];

            if (datapoints.length === 0) {
              recommendations.push(
                `${instanceId} (${instanceType}): Ingen CPU-data tillgänglig`
              );
            } else {
              const avgCpu =
                datapoints.reduce((sum, dp) => sum + (dp.Average ?? 0), 0) / datapoints.length;

              if (avgCpu < 5) {
                recommendations.push(
                  `${instanceId} (${instanceType}): UNDERUTNYTTJAD – genomsnittlig CPU ${avgCpu.toFixed(2)}% – överväg att stänga av eller skala ner`
                );
              } else {
                recommendations.push(
                  `${instanceId} (${instanceType}): OK – genomsnittlig CPU ${avgCpu.toFixed(2)}%`
                );
              }
            }
          }

          return {
            content: [{
              type: "text",
              text: recommendations.join("\n"),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Fel vid analys av instanser: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
      /*flatMap gör map + plattar ut ett nivå:                                                                                                                 
      [ instans1, instans2, instans3, instans4, instans5 ] */
    );

    this.server.tool(
      "find_orphaned_ebs_volumes",
      "Hittar EBS-volymer som inte är kopplade till någon EC2-instans och därmed genererar onödiga kostnader",
      {},
      async () => {
        try {
          const command = new DescribeVolumesCommand({
            Filters: [{
              Name: "status",
              Values: ["available"],
            }],
          });

          const response = await this.ec2Client.send(command);
          const volumes = response.Volumes ?? [];

          if (volumes.length === 0) {
            return {
              content: [{
                type: "text",
                text: "Inga oanvända EBS-volymer hittades.",
              }],
            };
          }

          const result = volumes.map((v) => ({
            id: v.VolumeId,
            size: `${v.Size} GB`,
            type: v.VolumeType,
            created: v.CreateTime,
            estimatedMonthlyCost: `$${((v.Size ?? 0) * 0.08).toFixed(2)}/månad`,
          }));

          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: "text",
              text: `Fel vid hämtning av EBS-volymer: ${error instanceof Error ? error.message : String(error)}`,
            }],
          };
        }
      }
    )
  }
    async run(): Promise<void> {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("aws-mcp-optimizer körs via stdio");
    }
  

};

new AwsMcpOptimizerServer().run();
