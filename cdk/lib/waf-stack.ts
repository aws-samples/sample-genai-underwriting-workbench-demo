import { Construct } from 'constructs';
import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Names } from 'aws-cdk-lib';

export class WAFStack extends cdk.Stack {
  public readonly webAclArn: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Generate Unique ID for name
    const wafUniqueId = Names.uniqueId(this);

    const whitelistIpSet = new wafv2.CfnIPSet(this, 'WhitelistIPSet', {
      name: cdk.Fn.join('-', ['WhitelistIPSet', wafUniqueId]),
      scope: 'CLOUDFRONT',
      ipAddressVersion: 'IPV4',
      addresses: []
    });

    const webAcl = new wafv2.CfnWebACL(this, 'WhitelistIPSetWebAcl', {
      name: cdk.Fn.join('-', ['WhitelistIPSetWebAcl', wafUniqueId]),
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