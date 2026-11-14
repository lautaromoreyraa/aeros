import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/** Where the pipeline's outputs, the raw FIRMS downloads and derived files live. */
export const DATA_LAYOUT = {
  harmonizedPrefix: "harmonized/",
  cellsKey: "harmonized/harmonized_cells.parquet",
  hotspotsKey: "harmonized/hotspots_harmonized.parquet",
  rawFirmsPrefix: "raw/firms/",
  earlyWarningKey: "derived/early_warning.json",
  /** GOES-19 fire pixels of the last scans, rewritten every 10 minutes. */
  goesLatestKey: "derived/goes_latest.json",
  /** What the last alert notification told people; private, never served. */
  alertStateKey: "state/alerts.json",
  /** Which cells the GOES watch already told people about; private too. */
  goesAlertStateKey: "state/goes_alerts.json",
} as const;

export interface DataStackProps extends StackProps {
  /** Days a raw FIRMS download is kept. */
  readonly rawRetentionDays: number;
}

/**
 * The data bucket outlives every other stack: the harmonized tables take a
 * full pipeline run to rebuild, so it is retained on delete. Storage is kept
 * small on purpose (free plan): raw NRT downloads expire once FIRMS' standard
 * archive replaces them, and overwritten versions go after a week.
 */
export class DataStack extends Stack {
  readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.bucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // SSE-S3: free, unlike a customer-managed KMS key.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: "expire-old-versions",
          // Enough to roll back a bad pipeline run or refresh.
          noncurrentVersionExpiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(1),
        },
        {
          id: "expire-raw-firms",
          prefix: DATA_LAYOUT.rawFirmsPrefix,
          expiration: Duration.days(props.rawRetentionDays),
        },
      ],
    });
  }
}
