param(
  [Parameter(Mandatory = $true)][string]$Domain,
  [Parameter(Mandatory = $true)][string]$HostedZoneId,
  [Parameter(Mandatory = $true)][string]$OwnerEmail,
  [string]$Region = 'ap-south-1',
  [string]$MongoInstanceType = 't3.small',
  [switch]$SkipDatabaseBootstrap
)
$ErrorActionPreference = 'Stop'
$projectDirectory = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location -LiteralPath $projectDirectory
foreach ($executable in @('aws', 'docker', 'node', 'npm.cmd')) { if (-not (Get-Command $executable -ErrorAction SilentlyContinue)) { throw "Install $executable before deployment. See docs/AWS-DEPLOYMENT.md." } }
function Invoke-Checked {
  param([string]$Executable, [string[]]$Arguments)
  & $Executable @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Executable failed. Deployment stopped; resolve the error before resuming." }
}
$accountInfo = (& aws sts get-caller-identity --output json) | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Sign in to the intended AWS account with aws configure sso and aws sso login first.' }
Write-Host "Deploying HAYA to AWS account $($accountInfo.Account), region $Region. This provisions billable resources."
$imageTag = 'release-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
$contextArguments = @('-c', "domain=$Domain", '-c', "hostedZoneId=$HostedZoneId", '-c', "ownerEmail=$OwnerEmail", '-c', "region=$Region", '-c', "mongoInstanceType=$MongoInstanceType")
Invoke-Checked 'npm.cmd' @('ci')
Invoke-Checked 'npm.cmd' @('test')
Invoke-Checked 'npm.cmd' @('run', 'build')
Invoke-Checked 'npm.cmd' @('ci', '--prefix', 'infra')
Push-Location -LiteralPath (Join-Path $projectDirectory 'infra')
try {
  Invoke-Checked 'npx.cmd' @('cdk', 'bootstrap', "aws://$($accountInfo.Account)/$Region")
  if ($Region -ne 'us-east-1') { Invoke-Checked 'npx.cmd' @('cdk', 'bootstrap', "aws://$($accountInfo.Account)/us-east-1") }
  if (-not $SkipDatabaseBootstrap) { Invoke-Checked 'npx.cmd' (@('cdk', 'deploy', 'HayaStack', '--outputs-file', (Join-Path $projectDirectory 'aws-outputs.json'), '-c', 'desiredCount=0') + $contextArguments) }
} finally { Pop-Location }
if (-not (Test-Path -LiteralPath (Join-Path $projectDirectory 'aws-outputs.json'))) { throw 'Missing aws-outputs.json. Run the initial deployment without -SkipDatabaseBootstrap first.' }
$stackOutputs = (Get-Content -LiteralPath 'aws-outputs.json' -Raw | ConvertFrom-Json).HayaStack
if (-not $SkipDatabaseBootstrap) { Invoke-Checked 'node' @('scripts/aws/bootstrap-mongo.mjs', "region=$Region", 'outputs=aws-outputs.json') }
$registry = $stackOutputs.RepositoryUri.Split('/')[0]
& aws ecr get-login-password --region $Region | & docker login --username AWS --password-stdin $registry
if ($LASTEXITCODE -ne 0) { throw 'ECR sign-in failed.' }
$imageUri = "$($stackOutputs.RepositoryUri):$imageTag"
Invoke-Checked 'docker' @('build', '--platform', 'linux/amd64', '-t', $imageUri, '.')
Invoke-Checked 'docker' @('push', $imageUri)
Push-Location -LiteralPath (Join-Path $projectDirectory 'infra')
try { Invoke-Checked 'npx.cmd' (@('cdk', 'deploy', 'HayaStack', '--outputs-file', (Join-Path $projectDirectory 'aws-outputs.json'), '-c', 'desiredCount=2', '-c', "imageTag=$imageTag") + $contextArguments) } finally { Pop-Location }
$stackOutputs = (Get-Content -LiteralPath 'aws-outputs.json' -Raw | ConvertFrom-Json).HayaStack
Invoke-Checked 'aws' @('s3', 'sync', 'dist/assets', "s3://$($stackOutputs.FrontendBucket)/assets", '--cache-control', 'public,max-age=31536000,immutable', '--region', $Region)
Invoke-Checked 'aws' @('s3', 'sync', 'dist', "s3://$($stackOutputs.FrontendBucket)", '--exclude', 'assets/*', '--exclude', 'index.html', '--cache-control', 'public,max-age=3600', '--region', $Region)
Invoke-Checked 'aws' @('s3', 'cp', 'dist/index.html', "s3://$($stackOutputs.FrontendBucket)/index.html", '--cache-control', 'no-cache,no-store,must-revalidate', '--content-type', 'text/html', '--region', $Region)
Invoke-Checked 'aws' @('cloudfront', 'create-invalidation', '--distribution-id', $stackOutputs.DistributionId, '--paths', '/', '/index.html', '/favicon.svg', '--region', $Region)
$null = & aws cognito-idp admin-get-user --user-pool-id $stackOutputs.UserPoolId --username $OwnerEmail --region $Region 2>$null
if ($LASTEXITCODE -ne 0) { Invoke-Checked 'aws' @('cognito-idp', 'admin-create-user', '--user-pool-id', $stackOutputs.UserPoolId, '--username', $OwnerEmail, '--user-attributes', "Name=email,Value=$OwnerEmail", 'Name=email_verified,Value=true', 'Name=name,Value=HAYA Owner', '--desired-delivery-mediums', 'EMAIL', '--region', $Region) }
Write-Host "HAYA deployment finished: $($stackOutputs.AppUrl)"
Write-Host 'Check the owner email for the Cognito invitation. Complete the production acceptance gates before operational use.'
