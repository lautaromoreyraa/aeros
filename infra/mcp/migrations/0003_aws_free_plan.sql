-- AWS constraints every assistant must respect when it touches infra/aws.

INSERT INTO conventions (key, value, updated_by) VALUES
  ('aws_free_plan',
   'HARD RULE: everything on AWS stays inside the AWS Free plan (credit-based, six months, one project Region, no cross-Region features, no Lambda@Edge). ' ||
   'Design for Always Free allowances so steady usage burns no credits: Lambda Function URLs behind CloudFront instead of API Gateway; ' ||
   'SSM Parameter Store SecureString (standard tier, AWS-managed key) instead of Secrets Manager; DNS stays in Cloudflare, so no Route 53 hosted zone; ' ||
   'no customer-managed KMS keys, NAT Gateways, VPC-attached Lambdas, load balancers or EC2; Lambda zip + layer instead of container images; ' ||
   'small memory and low reserved concurrency; S3 lifecycle expiry on raw data; CloudWatch Logs retention 7 days; an AWS Budgets alert at USD 1. ' ||
   'A CDK assertion test fails the build if a forbidden resource type appears. Check a service against ' ||
   'https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html before adding it.',
   'seed'),
  ('aws_docs',
   'Read AWS documentation through the AWS MCP server, which works without credentials: ' ||
   'uvx mcp-proxy-for-aws-cli==1.7.0 https://aws-mcp.us-east-1.api.aws/mcp --skip-auth ' ||
   '(tools aws___search_documentation, aws___read_documentation, aws___retrieve_skill, aws___get_regional_availability). ' ||
   'It ships with github.com/aws/agent-toolkit-for-aws (plugin aws-core). Before writing CDK, SDK or service configuration, ' ||
   'search the docs with topic agent_skills and load the matching skill instead of relying on memory.',
   'seed')
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
