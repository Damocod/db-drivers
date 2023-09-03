export const AwsServiceType = {
  S3: 'S3',
  SQS: 'SQS',
  SES: 'SES',
  Cloudwatch: 'Cloudwatch',
} as const;
export type AwsServiceType =
  (typeof AwsServiceType)[keyof typeof AwsServiceType];

export const AwsServiceTypeValues = Object.values(AwsServiceType);
