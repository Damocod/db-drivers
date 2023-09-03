/* eslint-disable no-async-promise-executor */
/* eslint-disable @typescript-eslint/no-unused-vars */

import {
  GetSendQuotaCommand,
  GetSendQuotaCommandInput,
  GetSendQuotaCommandOutput,
  GetSendStatisticsCommand,
  GetSendStatisticsCommandOutput,
  IdentityType,
  ListIdentitiesCommand,
  SESClient,
  VerifyDomainDkimCommandOutput,
  VerifyDomainIdentityCommand,
  VerifyDomainIdentityCommandInput,
  VerifyDomainIdentityCommandOutput,
  VerifyEmailAddressCommand,
  VerifyEmailAddressCommandInput,
  VerifyEmailAddressCommandOutput,
} from '@aws-sdk/client-ses';
import * as url from 'url';
import {
  AwsDatabase,
  DbKey,
  DbSQSQueue,
  ResultSetDataBuilder,
  SQSMessageParams,
  createRdhKey,
} from '../../resource';
import {
  AwsSQSAttributes,
  AwsServiceType,
  ConnectionSetting,
  GeneralColumnType,
  ResultSetData,
  ScanParams,
} from '../../types';
import { AwsServiceClient } from './AwsServiceClient';
import { ClientConfigType } from '../AwsDriver';
import { toBoolean, toDate, toNum } from '../../util';
import { Scannable } from '../BaseDriver';
import { plural } from 'pluralize';

export class AwsSESServiceClient extends AwsServiceClient {
  sesClient: SESClient;

  constructor(conRes: ConnectionSetting, config: ClientConfigType) {
    super(conRes, config);
  }

  protected async connectSub(): Promise<string> {
    this.sesClient = new SESClient(this.config);
    return this.test(false);
  }

  protected async testSub(): Promise<void> {
    if (this.sesClient) {
      await this.getSendQuota();
    }
  }

  async listIdentities(identityType: IdentityType): Promise<string[]> {
    let NextToken: string | undefined = undefined;
    const list: string[] = [];
    do {
      const res = await this.sesClient.send(
        new ListIdentitiesCommand({
          IdentityType: identityType,
          MaxItems: 1000,
        }),
      );
      list.push(...res.Identities);
      NextToken = res.NextToken;
    } while (NextToken);

    return list;
  }

  async verifyEmailAddress(
    emailAddress: string,
  ): Promise<VerifyEmailAddressCommandOutput> {
    return await this.sesClient.send(
      new VerifyEmailAddressCommand({
        EmailAddress: emailAddress,
      }),
    );
  }

  async verifyDomainIdentity(
    domain: string,
  ): Promise<VerifyDomainIdentityCommandOutput> {
    return await this.sesClient.send(
      new VerifyDomainIdentityCommand({
        Domain: domain,
      }),
    );
  }

  async getSendQuota(): Promise<GetSendQuotaCommandOutput> {
    return await this.sesClient.send(new GetSendQuotaCommand({}));
  }

  async getSendStatistics(): Promise<GetSendStatisticsCommandOutput> {
    return await this.sesClient.send(new GetSendStatisticsCommand({}));
  }

  async getInfomationSchemas(): Promise<AwsDatabase> {
    if (!this.conRes) {
      return null;
    }
    const dbDatabase = new AwsDatabase('SES', AwsServiceType.SES);
    const { Max24HourSend, SentLast24Hours } = await this.getSendQuota();
    dbDatabase.comment = `Max24HourSend:${Max24HourSend}, SentLast24Hours:${SentLast24Hours}`;

    return dbDatabase;
  }

  protected async closeSub(): Promise<void> {
    await this.sesClient.destroy();
  }
}
