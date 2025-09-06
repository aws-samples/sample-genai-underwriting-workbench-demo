#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import { WAFStack } from '../lib/waf-stack';
import { AwsSolutionsChecks } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib';

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

// Create WAF stack in us-east-1 for CloudFront
const wafStack = new WAFStack(app, 'AWS-GENAI-UW-DEMO-WAF', {
  env: { account, region: 'us-east-1' },
  crossRegionReferences: true,
  description: 'WAF resources for CloudFront distribution'
});

// Create main stack in us-east-2
new CdkStack(app, 'AWS-GENAI-UW-DEMO', {
  env: { account, region },
  crossRegionReferences: true,
  webAclArn: wafStack.webAclArn,
  description: 'AWS Underwriting Assistant'
});

Aspects.of(app).add(new AwsSolutionsChecks());