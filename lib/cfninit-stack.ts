import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from "aws-cdk-lib";
import { AutoScalingGroup, Signals } from "aws-cdk-lib/aws-autoscaling";
import {
  BuildSpec,
  LinuxBuildImage,
  PipelineProject,
} from "aws-cdk-lib/aws-codebuild";
import { ServerDeploymentGroup } from "aws-cdk-lib/aws-codedeploy";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CodeBuildAction,
  CodeDeployServerDeployAction,
  GitHubSourceAction,
} from "aws-cdk-lib/aws-codepipeline-actions";
import {
  AmazonLinuxGeneration,
  AmazonLinuxImage,
  CloudFormationInit,
  InitCommand,
  InitFile,
  InitPackage,
  InitService,
  InitServiceRestartHandle,
  InstanceType,
  IpAddresses,
  KeyPair,
  LaunchTemplate,
  Peer,
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
} from "aws-cdk-lib/aws-ec2";
import {
  CompositePrincipal,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class CfninitStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // VPC
    const vpc = new Vpc(this, "VPC", {
      vpcName: "cfninit-vpc",
      ipAddresses: IpAddresses.cidr("10.0.0.0/16"),
      maxAzs: 1,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "Public",
          subnetType: SubnetType.PUBLIC,
        },
      ],
    });

    // Security Group
    const securityGroup = new SecurityGroup(this, "SecurityGroup", {
      securityGroupName: "cfninit-sg",
      vpc,
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(443),
      "allow https access",
    );
    securityGroup.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      "allow http access",
    );
    securityGroup.addIngressRule(
      Peer.ipv4("0.0.0.0/0"),
      Port.tcp(22),
      "allow ssh access",
    );

    // InstanceTemplate
    const autoScalingGroup = new AutoScalingGroup(this, "AutoScalingGroup", {
      vpc,
      launchTemplate: new LaunchTemplate(this, "LaunchTemplate", {
        instanceType: new InstanceType("t2.micro"),
        machineImage: new AmazonLinuxImage({
          generation: AmazonLinuxGeneration.AMAZON_LINUX_2023,
        }),
        securityGroup,
        role: new Role(this, "Role", {
          assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
          managedPolicies: [
            ManagedPolicy.fromAwsManagedPolicyName(
              "AmazonSSMManagedInstanceCore",
            ),
          ],
        }),
        keyPair: new KeyPair(this, "CfnInitKeyPair", {
          keyPairName: "CfnInitKeyPair",
        }),
      }),
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      init: CloudFormationInit.fromElements(
        InitPackage.yum("nginx"),
        InitCommand.shellCommand(
          "sudo yum install php php-fpm php-xml php-mbstring php-zip php-bcmath php-tokenizer ruby wget sqlite -y",
        ),
        InitFile.fromAsset(
          "/etc/nginx/conf.d/laravel.conf", // Destination
          "cfninit/laravel.conf", // Where the file is located
        ),
        InitService.enable("nginx", {
          serviceRestartHandle: new InitServiceRestartHandle(),
        }),
      ),
      signals: Signals.waitForCount(1, {
        minSuccessPercentage: 80,
        timeout: Duration.minutes(5),
      }),
    });

    const sourceArtifact = new Artifact("SourceArtifact");
    const buildArtifact = new Artifact("BuildArtifact");

    new Pipeline(this, "Pipeline", {
      pipelineName: "Laravel-pipeline",
      role: new Role(this, "PipelineRole", {
        assumedBy: new CompositePrincipal(
          new ServicePrincipal("codebuild.amazonaws.com"),
          new ServicePrincipal("codepipeline.amazonaws.com"),
        ),
        inlinePolicies: {
          CdkDeployPermissions: new PolicyDocument({
            statements: [
              new PolicyStatement({
                actions: ["sts:AssumeRole"],
                resources: ["arn:aws:iam::*:role/cdk-*"],
              }),
            ],
          }),
        },
      }),
      artifactBucket: new Bucket(this, "ArtifactBucket", {
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      stages: [
        {
          stageName: "Source",
          actions: [
            new GitHubSourceAction({
              actionName: "Source",
              owner: "RizaHKhan",
              repo: "laravel-app-for-cdk",
              branch: "master",
              oauthToken: SecretValue.secretsManager("github-token"),
              output: sourceArtifact,
            }),
          ],
        },
        {
          stageName: "Build",
          actions: [
            new CodeBuildAction({
              actionName: "Build",
              project: new PipelineProject(this, "BuildProject", {
                environment: {
                  buildImage: LinuxBuildImage.AMAZON_LINUX_2_5,
                },
                buildSpec: BuildSpec.fromObject({
                  version: "0.2",
                  phases: {
                    install: {
                      "runtime-versions": {
                        nodejs: "20.x",
                        php: "8.3",
                      },
                      commands: [
                        "npm install",
                        "curl -sS https://getcomposer.org/installer | php", // Install Composer
                        "php composer.phar install --no-dev --optimize-autoloader", // Install PHP dependencies
                      ],
                    },
                    build: {
                      commands: ["npm run build"],
                    },
                  },
                  artifacts: {
                    "base-directory": "./", // Adjust this to the appropriate base directory if different
                    files: [
                      "**/*", // Frontend assets
                    ],
                  },
                }),
              }),
              input: sourceArtifact,
              outputs: [buildArtifact],
            }),
          ],
        },
        {
          stageName: "Deploy",
          actions: [
            new CodeDeployServerDeployAction({
              actionName: "DeployToEc2",
              input: buildArtifact,
              deploymentGroup: new ServerDeploymentGroup(
                this,
                "DeploymentGroup",
                {
                  autoScalingGroups: [autoScalingGroup],
                },
              ),
            }),
          ],
        },
      ],
    });
  }
}
