import { Controller, Get } from '@nestjs/common';
import { BotFeatureProvider, RawZodSchema } from '@x-ai-wallet-bot/common';
import zodToJsonSchema from 'zod-to-json-schema';
import { BotFeatureService } from './bot-feature.service';

@Controller('bot-features')
export class BotFeatureController {
  constructor(
    private botFeatureService: BotFeatureService
  ) { }

  @Get('providers')
  public async getBotFeatureProviders(): Promise<BotFeatureProvider[]> {
    const providers = await this.botFeatureService.getFeatureProviders();
    return providers.map(fp => ({
      groupType: fp.groupType,
      type: fp.type,
      title: fp.title,
      description: fp.description,
      configFormat: zodToJsonSchema(fp.configFormat) as RawZodSchema
    }));
  }
}
