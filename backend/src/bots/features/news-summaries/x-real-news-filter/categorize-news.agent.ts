import { MessagesAnnotation } from "@langchain/langgraph";
import { Logger } from "@nestjs/common";
import { XPost } from "@prisma/client";
import { BotFeature } from "src/bots/model/bot-feature";
import { aiPromptsService, langchainService } from "src/services";
import { categorizeNewsTool } from "./categorize-news.tool";

export const categorizeNewsAgent = (feature: BotFeature, logger: Logger, post: XPost) => {
  return async (state: typeof MessagesAnnotation.State) => {
    const { responseMessage } = await langchainService().fullyInvoke({
      messages: [["system", await aiPromptsService().get(feature.bot, "news-summaries/categorize-news")]],
      invocationParams: { tweetContent: post.text },
      tools: [
        categorizeNewsTool(logger, post) // ability to update a DB post with "isRealNews" info
      ]
    });
    return responseMessage;
  }
};