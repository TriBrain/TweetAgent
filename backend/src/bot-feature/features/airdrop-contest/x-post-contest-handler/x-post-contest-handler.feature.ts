import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { BotFeatureGroupType, BotFeatureType } from "@x-ai-wallet-bot/common";
import { BotFeature } from "src/bot-feature/model/bot-feature";
import { BotFeatureProvider, BotFeatureProviderConfigBase, DefaultFeatureConfigType } from "src/bot-feature/model/bot-feature-provider";
import { XPostReplyAnalysisResult } from "src/bot-feature/model/x-post-reply-analysis-result";
import { Bot } from "src/bots/model/bot";
import { AppLogger } from "src/logs/app-logger";
import { XPostWithAccount } from "src/xposts/model/xpost-with-account";
import { z, infer as zodInfer } from "zod";
import { studyForContest } from "./default-prompts";
import { studyForContestAgent } from "./study-for-contest.agent";

const FeatureConfigFormat = BotFeatureProviderConfigBase.extend({
  _prompts: z.object({
    studyForContest: z.string()
  })
}).strict();

type FeatureConfigType = Required<zodInfer<typeof FeatureConfigFormat>>;

export class XPostContestHandlerProvider extends BotFeatureProvider<XPostContestHandlerFeature, typeof FeatureConfigFormat> {
  constructor() {
    super(
      BotFeatureGroupType.AirdropContest,
      BotFeatureType.AirdropContest_XPostContestHandler,
      `Post handler`,
      `Classifies upcoming X posts as eligible for the airdrop contest or not`,
      FeatureConfigFormat,
      (bot: Bot) => new XPostContestHandlerFeature(this, bot)
    );
  }

  public getDefaultConfig(): DefaultFeatureConfigType<z.infer<typeof FeatureConfigFormat>> {
    return {
      enabled: true,
      _prompts: {
        studyForContest
      }
    }
  }
}

export const contestHandlerStateAnnotation = Annotation.Root({
  isWorthForContest: Annotation<boolean>,
  reply: Annotation<string>
});

/**
 * This feature handles upcoming posts and checks if they are eligible for the airdrop contest,
 * then reply to users if they are.
 */
export class XPostContestHandlerFeature extends BotFeature<FeatureConfigType> {
  private logger = new AppLogger("XPostContestHandler", this.bot);

  constructor(provider: XPostContestHandlerProvider, bot: Bot) {
    super(provider, bot, 5);
  }

  async studyReplyToXPost(post: XPostWithAccount): Promise<XPostReplyAnalysisResult> {
    this.logger.log("Studying reply to X post");

    // Don't reply to ourself
    if (post.xAccountUserId === this.bot.dbBot.twitterUserId)
      return null;

    const graph = new StateGraph(contestHandlerStateAnnotation)
      .addNode("StudyForContest", studyForContestAgent(this, this.logger, post))
      .addEdge(START, END)
      .addEdge(START, "StudyForContest")
      .addEdge("StudyForContest", END)

    const app = graph.compile();
    const result: typeof contestHandlerStateAnnotation.State = await app.invoke({});

    return { reply: result?.reply }
  }
}