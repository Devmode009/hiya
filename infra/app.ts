import * as cdk from 'aws-cdk-lib';
import { aws_ec2 as ec2, aws_ecs as ecs, aws_ecr as ecr, aws_ecs_patterns as patterns, aws_s3 as s3, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_cognito as cognito, aws_secretsmanager as secrets, aws_iam as iam, aws_logs as logs, aws_route53 as route53, aws_route53_targets as targets, aws_certificatemanager as acm, aws_backup as backup } from 'aws-cdk-lib';

const app = new cdk.App();
const region = app.node.tryGetContext('region') || process.env.CDK_DEFAULT_REGION || 'ap-south-1';
const stack = new cdk.Stack(app, 'HayaStack', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region }, crossRegionReferences: true, description: 'HAYA MERN: private MongoDB replica set, ECS API, Cognito, S3 and CloudFront.' });
const domain = app.node.tryGetContext('domain');
const hostedZoneId = app.node.tryGetContext('hostedZoneId');
const ownerEmail = app.node.tryGetContext('ownerEmail');
if (!domain || !hostedZoneId || !ownerEmail) throw new Error('Supply -c domain=example.com -c hostedZoneId=Z... -c ownerEmail=owner@example.com. See docs/AWS-DEPLOYMENT.md.');
const appDomain = `app.${domain}`;
const appOrigin = `https://${appDomain}`;
// CloudFront certificates must be issued in us-east-1, regardless of application region.
const edgeStack = new cdk.Stack(app, 'HayaEdgeStack', { env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' }, crossRegionReferences: true });
const edgeZone = route53.HostedZone.fromHostedZoneAttributes(edgeStack, 'PublicZone', { hostedZoneId, zoneName: domain });
const frontendCertificate = new acm.Certificate(edgeStack, 'FrontendCertificate', { domainName: appDomain, validation: acm.CertificateValidation.fromDns(edgeZone) });
frontendCertificate.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
const desiredCount = Number(app.node.tryGetContext('desiredCount') || 0);
const imageTag = app.node.tryGetContext('imageTag') || 'initial';
const databaseInstanceType = app.node.tryGetContext('mongoInstanceType') || 't3.small';

const vpc = new ec2.Vpc(stack, 'Vpc', { maxAzs: 3, natGateways: 1, subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }, { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 }] });
const zone = route53.HostedZone.fromHostedZoneAttributes(stack, 'PublicZone', { hostedZoneId, zoneName: domain });
const mongoZone = new route53.PrivateHostedZone(stack, 'MongoZone', { zoneName: 'mongo.haya.internal', vpc });
const apiDomain = `api.${domain}`;
const certificate = new acm.Certificate(stack, 'ApiCertificate', { domainName: apiDomain, validation: acm.CertificateValidation.fromDns(zone) });
const repository = new ecr.Repository(stack, 'ApiRepository', { imageScanOnPush: true, lifecycleRules: [{ maxImageCount: 15 }], removalPolicy: cdk.RemovalPolicy.RETAIN });
const evidence = new s3.Bucket(stack, 'Evidence', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, versioned: true, enforceSSL: true, removalPolicy: cdk.RemovalPolicy.RETAIN });
const frontend = new s3.Bucket(stack, 'Frontend', { blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, versioned: true, enforceSSL: true, removalPolicy: cdk.RemovalPolicy.RETAIN });
const mongoRoot = new secrets.Secret(stack, 'MongoRoot', { generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'hayaRoot' }), generateStringKey: 'password', passwordLength: 40, excludePunctuation: true } });
const mongoApp = new secrets.Secret(stack, 'MongoApp', { generateSecretString: { secretStringTemplate: JSON.stringify({ username: 'hayaApp', uri: 'pending-bootstrap', ca: 'pending-bootstrap' }), generateStringKey: 'password', passwordLength: 40, excludePunctuation: true } });
const mongoCluster = new secrets.Secret(stack, 'MongoCluster', { secretObjectValue: { status: cdk.SecretValue.unsafePlainText('pending-bootstrap') } });
const originSecret = new secrets.Secret(stack, 'OriginSecret', { generateSecretString: { passwordLength: 48, excludePunctuation: true } });
for (const secret of [mongoRoot, mongoApp, mongoCluster, originSecret]) secret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
const mongoSecurity = new ec2.SecurityGroup(stack, 'MongoSecurity', { vpc, description: 'MongoDB: replica members and API tasks only; no public or SSH ingress.' });
mongoSecurity.addIngressRule(mongoSecurity, ec2.Port.tcp(27017), 'Replica traffic with TLS and keyfile authentication');
const mongoRole = new iam.Role(stack, 'MongoRole', { assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'), managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')] });
mongoRoot.grantRead(mongoRole); mongoApp.grantRead(mongoRole); mongoApp.grantWrite(mongoRole); mongoCluster.grantRead(mongoRole); mongoCluster.grantWrite(mongoRole);
const nodes: ec2.Instance[] = [];
for (let i = 0; i < 3; i++) {
  const node = new ec2.Instance(stack, `Mongo${i + 1}`, { vpc, vpcSubnets: { subnets: [vpc.privateSubnets[i % vpc.privateSubnets.length]] }, instanceType: new ec2.InstanceType(databaseInstanceType), machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.X86_64 }), role: mongoRole, securityGroup: mongoSecurity, requireImdsv2: true, blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(100, { encrypted: true, volumeType: ec2.EbsDeviceVolumeType.GP3, deleteOnTermination: false }) }] });
  node.addUserData('set -eu', 'dnf install -y docker python3 openssl', 'systemctl enable --now docker', 'mkdir -p /opt/haya/mongo /opt/haya/tls', 'chmod 700 /opt/haya/mongo /opt/haya/tls', 'docker pull mongo:8.0', 'touch /opt/haya/ready');
  node.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
  new route53.ARecord(stack, `MongoDns${i + 1}`, { zone: mongoZone, recordName: `mongo${i + 1}`, target: route53.RecordTarget.fromIpAddresses(node.instancePrivateIp), ttl: cdk.Duration.seconds(30) });
  nodes.push(node);
}
const vault = new backup.BackupVault(stack, 'BackupVault', { removalPolicy: cdk.RemovalPolicy.RETAIN });
const plan = backup.BackupPlan.daily35DayRetention(stack, 'DatabaseBackups', vault);
plan.addSelection('MongoVolumes', { resources: nodes.map(n => backup.BackupResource.fromEc2Instance(n)) });

const cluster = new ecs.Cluster(stack, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });
const apiService = new patterns.ApplicationLoadBalancedFargateService(stack, 'Api', {
  cluster, cpu: 512, memoryLimitMiB: 1024, desiredCount: Math.max(1, desiredCount), publicLoadBalancer: true, certificate, domainName: apiDomain, domainZone: zone,
  redirectHTTP: true, listenerPort: 443, taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }, assignPublicIp: false,
  healthCheckGracePeriod: cdk.Duration.seconds(120), circuitBreaker: { rollback: true }, minHealthyPercent: 100, maxHealthyPercent: 200,
  taskImageOptions: { image: ecs.ContainerImage.fromEcrRepository(repository, imageTag), containerPort: 4000, environment: { NODE_ENV: 'production', PORT: '4000', AWS_REGION: region, MONGODB_DATABASE: 'haya', S3_BUCKET: evidence.bucketName, BOOTSTRAP_OWNER_EMAIL: ownerEmail }, secrets: { MONGODB_URI: ecs.Secret.fromSecretsManager(mongoApp, 'uri'), MONGODB_CA_PEM: ecs.Secret.fromSecretsManager(mongoApp, 'ca'), ORIGIN_SECRET: ecs.Secret.fromSecretsManager(originSecret) }, logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'haya-api', logRetention: logs.RetentionDays.ONE_MONTH }) },
});
// The pattern validates a positive desiredCount; the initial bootstrap intentionally deploys no tasks.
(apiService.service.node.defaultChild as ecs.CfnService).desiredCount = desiredCount;
mongoSecurity.addIngressRule(apiService.service.connections.securityGroups[0], ec2.Port.tcp(27017), 'HAYA API database access');
apiService.targetGroup.configureHealthCheck({ path: '/api/health', healthyHttpCodes: '200', interval: cdk.Duration.seconds(30), timeout: cdk.Duration.seconds(5) });
apiService.service.autoScaleTaskCount({ minCapacity: desiredCount === 0 ? 0 : 2, maxCapacity: 6 }).scaleOnCpuUtilization('CpuScaling', { targetUtilizationPercent: 65, scaleInCooldown: cdk.Duration.minutes(5), scaleOutCooldown: cdk.Duration.seconds(60) });
evidence.grantRead(apiService.taskDefinition.taskRole);
evidence.grantPut(apiService.taskDefinition.taskRole);

const distribution = new cf.Distribution(stack, 'Distribution', {
  defaultRootObject: 'index.html', domainNames: [appDomain], certificate: frontendCertificate, minimumProtocolVersion: cf.SecurityPolicyProtocol.TLS_V1_2_2021, priceClass: cf.PriceClass.PRICE_CLASS_200,
  defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(frontend), viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, compress: true, cachePolicy: cf.CachePolicy.CACHING_OPTIMIZED, responseHeadersPolicy: cf.ResponseHeadersPolicy.SECURITY_HEADERS },
  additionalBehaviors: { '/api/*': { origin: new origins.HttpOrigin(apiDomain, { protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY, customHeaders: { 'X-Haya-Origin': originSecret.secretValue.unsafeUnwrap() } }), viewerProtocolPolicy: cf.ViewerProtocolPolicy.HTTPS_ONLY, allowedMethods: cf.AllowedMethods.ALLOW_ALL, cachePolicy: cf.CachePolicy.CACHING_DISABLED, originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER, responseHeadersPolicy: cf.ResponseHeadersPolicy.SECURITY_HEADERS } },
});
new route53.ARecord(stack, 'FrontendDns', { zone, recordName: 'app', target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
new route53.AaaaRecord(stack, 'FrontendDnsIpv6', { zone, recordName: 'app', target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)) });
const pool = new cognito.UserPool(stack, 'Users', { selfSignUpEnabled: false, signInAliases: { email: true }, autoVerify: { email: true }, standardAttributes: { email: { required: true, mutable: false }, fullname: { required: true, mutable: true } }, passwordPolicy: { minLength: 12, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: true }, mfa: cognito.Mfa.OPTIONAL, mfaSecondFactor: { sms: false, otp: true }, accountRecovery: cognito.AccountRecovery.EMAIL_ONLY, removalPolicy: cdk.RemovalPolicy.RETAIN });
const poolDomain = pool.addDomain('HostedDomain', { cognitoDomain: { domainPrefix: `haya-${stack.account}-${region}` } });
const poolClient = pool.addClient('WebClient', { generateSecret: false, preventUserExistenceErrors: true, supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO], oAuth: { flows: { authorizationCodeGrant: true }, scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE], callbackUrls: [`${appOrigin}/api/auth/callback`], logoutUrls: [`${appOrigin}/`] }, accessTokenValidity: cdk.Duration.hours(1), idTokenValidity: cdk.Duration.hours(1), refreshTokenValidity: cdk.Duration.days(1) });
const container = apiService.taskDefinition.defaultContainer!;
container.addEnvironment('APP_ORIGIN', appOrigin);
container.addEnvironment('COGNITO_DOMAIN', poolDomain.baseUrl());
container.addEnvironment('COGNITO_USER_POOL_ID', pool.userPoolId);
container.addEnvironment('COGNITO_CLIENT_ID', poolClient.userPoolClientId);
apiService.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDeleteUser'], resources: [pool.userPoolArn] }));

const output = (key: string, value: string) => new cdk.CfnOutput(stack, key, { value });
output('AppUrl', appOrigin); output('FrontendBucket', frontend.bucketName); output('DistributionId', distribution.distributionId);
output('RepositoryUri', repository.repositoryUri); output('ClusterName', cluster.clusterName); output('ServiceName', apiService.service.serviceName);
output('UserPoolId', pool.userPoolId); output('MongoAppSecret', mongoApp.secretArn); output('MongoRootSecret', mongoRoot.secretArn); output('MongoClusterSecret', mongoCluster.secretArn);
nodes.forEach((node, i) => output(`MongoNode${i + 1}`, node.instanceId));
cdk.Tags.of(stack).add('Application', 'HAYA');
app.synth();
