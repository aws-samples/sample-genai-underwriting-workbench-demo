import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';

export class WAFStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const whitelistIpSet = new wafv2.CfnIPSet(this, 'WhitelistIPSet', {
      name: 'WhitelistIPSet',
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: []
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WhitelistIPSetWebAcl', {
      name: 'WhitelistIPSetWebAcl',
      scope: 'CLOUDFRONT',
      defaultAction: {
        allow: {}
      },
      rules: [
        {
          name: 'AllowWhitelistIPSetRule',
          priority: 1,
          statement: {
            ipSetReferenceStatement: {
              arn: whitelistIpSet.attrArn,
            }
          },
          action: {
            allow: {}
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AllowWhitelistIPSetRule',
          }
        }
      ],
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'CloudFrontWebAcl',
      },
    });

    this.webAclArn = webAcl.attrArn;
  }
}