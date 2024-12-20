import { Injectable } from "@nestjs/common";
import { BotFeature as DBBotFeature } from "@prisma/client";
import { BotFeatureType } from "@x-ai-wallet-bot/common";
import { PrismaService } from "src/prisma/prisma.service";
import { deepMergeAndPrune } from "src/utils/deep-merge-prune";
import { Bot } from "../bots/model/bot";
import { AirdropSenderProvider } from "./features/airdrop-contest/airdrop-sender/airdrop-sender.feature";
import { AirdropSnapshotProvider } from "./features/airdrop-contest/airdrop-snapshot/airdrop-snapshot.feature";
import { XPostAirdropAddressProvider } from "./features/airdrop-contest/x-post-airdrop-address/x-post-airdrop-address.feature";
import { XPostContestHandlerProvider } from "./features/airdrop-contest/x-post-contest-handler/x-post-contest-handler.feature";
import { XPostContestReposterProvider } from "./features/airdrop-contest/x-post-contest-reposter/x-post-contest-reposter.feature";
import { GenericReplierProvider } from "./features/core/generic-replier/generic-replier.feature";
import { RootSchedulerFeatureProvider } from "./features/core/root-scheduler/root-scheduler.feature";
import { XNewsSummaryWriterProvider } from "./features/news-summaries/x-news-summary-writer/x-summary-writer.feature";
import { XRealNewsFilterProvider } from "./features/news-summaries/x-real-news-filter/x-real-news-filter.feature";
import { XPostsFetcherProvider } from "./features/x-core/x-posts-fetcher/x-post-fetcher.feature";
import { XPostsHandlerProvider } from "./features/x-core/x-posts-handler/x-posts-handler.feature";
import { XPostsSenderProvider } from "./features/x-core/x-posts-sender/x-post-sender.feature";
import { AnyBotFeature } from "./model/bot-feature";
import { AnyBotFeatureProvider, DefaultFeatureConfigType } from "./model/bot-feature-provider";

@Injectable()
export class BotFeatureService {
  private featureProviders: AnyBotFeatureProvider[];

  constructor(private prisma: PrismaService) {
    this.registerFeatureProviders();
  }

  public registerFeatureProviders() {
    this.featureProviders = [
      // Root
      new RootSchedulerFeatureProvider(),
      // Core
      new XPostsFetcherProvider(),
      new XPostsHandlerProvider(),
      new XPostsSenderProvider(),
      // Airdrop contest
      new AirdropSnapshotProvider(),
      new AirdropSenderProvider(),
      new XPostAirdropAddressProvider(),
      new XPostContestReposterProvider(),
      new XPostContestHandlerProvider(),
      // News summaries
      new XRealNewsFilterProvider(),
      new GenericReplierProvider(),
      new XNewsSummaryWriterProvider(),
    ]
  }

  public getFeatureProviders(): AnyBotFeatureProvider[] {
    return this.featureProviders;
  }

  public getFeatureProvider(type: BotFeatureType): AnyBotFeatureProvider {
    const provider = this.featureProviders.find(p => p.type === type);
    if (!provider)
      throw new Error(`Feature provider with type ${type} is not registered`);

    return provider;
  }

  /**
   * Instantiates a memory feature instance specific to a bot
   */
  public async newFromDBFeature(bot: Bot, dbFeature: DBBotFeature): Promise<AnyBotFeature> {
    const provider = this.getFeatureProvider(dbFeature.type as BotFeatureType);
    const feature = provider.newInstance(bot, dbFeature);

    // Safety check
    if (feature.runLoopMinIntervalSec === undefined && feature.scheduledExecution !== undefined)
      throw new Error(`Feature ${feature.type} has an execution method but no loop interval configured!`);

    await feature.initialize();

    return feature;
  }

  /**
   * Ensures all required bot features types are created in database for the given bot.
   * Also ensure to migrate all stored feature config, meaning that invalid properties (recently removed
   * from the format) are getting deleted, and missing ones (recently added in format) get default values defined.
   */
  public async ensureBotRequiredFeatures(bot: Bot) {
    const requiredBotFeatureTypes = Object.values(BotFeatureType);
    for (const requiredBotFeatureType of requiredBotFeatureTypes) {
      const feature = await this.prisma.botFeature.upsert({
        where: {
          botId_type: {
            botId: bot.dbBot.id,
            type: requiredBotFeatureType
          }
        },
        create: {
          bot: { connect: { id: bot.dbBot.id } },
          type: requiredBotFeatureType,
          config: {}
        },
        update: {}
      });

      // Now ensure config quality
      const provider = this.getFeatureProvider(feature.type as BotFeatureType);
      const defaultConfig = provider.getDefaultConfig();

      // Deep merge default config with current user config, and prune removed fields
      const newConfig = deepMergeAndPrune(defaultConfig, feature.config)

      await this.prisma.botFeature.update({
        where: { id: feature.id },
        data: { config: newConfig }
      });
    }
  }

  /**
   * Resets a feature config to its default values and returns the new feature entry
   */
  public async resetBotFeatureConfig(bot: Bot, feature: AnyBotFeature): Promise<DefaultFeatureConfigType> {
    const defaultConfig = feature.provider.getDefaultConfig();

    const updatedDbFeature = await this.prisma.botFeature.update({
      where: {
        botId_type: {
          botId: bot.id,
          type: feature.provider.type
        }
      },
      data: { config: defaultConfig }
    });

    feature.updateDBFeature(updatedDbFeature);

    return defaultConfig;
  }
}