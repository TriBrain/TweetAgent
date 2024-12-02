import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { BotFeatureType, XPost } from "@prisma/client";
import moment from "moment";
import { BotFeature } from "src/bot-feature/model/bot-feature";
import { BotFeatureProvider, BotFeatureProviderConfigBase } from "src/bot-feature/model/bot-feature-provider";
import { Bot } from "src/bots/model/bot";
import { BotConfig } from "src/config/bot-config";
import { AppLogger } from "src/logs/app-logger";
import { prisma } from "src/services";
import { infer as zodInfer } from "zod";
import { electBestPostForContestAgent } from "./elect-best-post-for-contest.agent";
import { writePostQuoteContentAgent } from "./write-post-quote-content.agent";

const FeatureConfigFormat = BotFeatureProviderConfigBase.extend({
  //snapshotInterval: z.number().describe('Min delay (in seconds) between 2 airdrop snapshots')
}).strict();

type FeatureConfigType = Required<zodInfer<typeof FeatureConfigFormat>>;

export class XPostContestReposterProvider extends BotFeatureProvider<XPostContestReposterFeature, typeof FeatureConfigFormat> {
  constructor() {
    super(
      BotFeatureType.AirdropContest_XPostContestReposter,
      `RTs user posts from time to time, for the airdrop contest`,
      FeatureConfigFormat,
      (bot: Bot) => new XPostContestReposterFeature(this, bot)
    );
  }

  protected getDefaultConfig(): Required<zodInfer<typeof FeatureConfigFormat>> {
    return {
      enabled: false,
      //snapshotInterval: 24 * 60 * 60 // 1 per day
    }
  }
}

export const contestReposterStateAnnotation = Annotation.Root({
  electedPost: Annotation<XPost>,
  reply: Annotation<string>
});

/**
 * This feature publishes RTs of elected contest posts from time to time.
 */
export class XPostContestReposterFeature extends BotFeature<FeatureConfigType> {
  private logger = new AppLogger("XPostContestReposter", this.bot);

  constructor(provider: XPostContestReposterProvider, bot: Bot) {
    super(provider, bot, 20);
  }

  public isEnabled(): boolean {
    return BotConfig.AirdropContest.IsActive;
  }

  async scheduledExecution() {
    // Ensure to not elect/RT contest posts too often (like every 1 hour)
    const mostRecentContestQuote = await prisma().xPost.findFirst({
      where: {
        botId: this.bot.id,
        contestQuotedPost: { isNot: null }
      },
      orderBy: { createdAt: "desc" }
    });

    if (mostRecentContestQuote && moment().diff(mostRecentContestQuote.createdAt, "minutes") < 60)
      return;

    this.logger.log(`Post contest reposter scheduled execution`);

    const graph = new StateGraph(contestReposterStateAnnotation)
      .addNode("ElectBestPost", electBestPostForContestAgent(this, this.logger))
      .addNode("WriteQuoteIntro", writePostQuoteContentAgent(this, this.logger));

    graph.addEdge(START, "ElectBestPost")
      .addEdge("ElectBestPost", "WriteQuoteIntro")
      .addEdge("WriteQuoteIntro", END)

    const app = graph.compile();
    const result: typeof contestReposterStateAnnotation.State = await app.invoke({});

    if (result?.electedPost && result?.reply) {
      // A post has been elected for quoting. Schedule the post to X and mark it has handled.

      // Schedule the post
      this.logger.log("Scheduling new X reply post");
      await prisma().xPost.create({
        data: {
          bot: { connect: { id: this.bot.dbBot.id } },
          publishRequestAt: new Date(),
          text: result.reply,
          xAccount: { connect: { userId: this.bot.dbBot.twitterUserId } },
          quotedPostId: result.electedPost.postId, // twitter id
          contestQuotedPost: { connect: { id: result.electedPost.id } },
          isSimulated: result.electedPost.isSimulated
        }
      });

      // Mark user's source post as handled for the contest so we don't try to use it any more.
      await prisma().xPost.update({
        where: { id: result.electedPost.id },
        data: {
          quotedForAirdropContestAt: new Date()
        }
      });
    }
  }
}