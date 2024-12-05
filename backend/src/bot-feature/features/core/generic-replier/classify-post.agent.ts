import { ChatPromptTemplate } from "@langchain/core/prompts";
import { XPost } from "@prisma/client";
import { AnyBotFeature } from "src/bot-feature/model/bot-feature";
import { aiPromptsService, langchainService } from "src/services";
import { z } from "zod";
import { replierStateAnnotation } from "./generic-replier.feature";
import { TweetTrait } from "./model/tweet-trait";

/**
 * Determines tweet traits and stores traits in the global state
 */
export const classifyPostAgent = (feature: AnyBotFeature, reply: XPost) => {
  return async (state: typeof replierStateAnnotation.State) => {
    const traitSchema = z.object({
      traits: z
        .array(z.string())
        .describe("The list of traits that characterize the tweet according to the requirements"),
    });

    const model = langchainService().getModel().withStructuredOutput(traitSchema, {
      name: "extract_tweet_traits",
      strict: true
    });

    // No actual user message, everything is in the system prompt.
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", await aiPromptsService().get(feature.bot, "news-summaries/classify-post")]
    ]);

    const response = await prompt.pipe(model).invoke({ tweetContent: reply.text });

    state.tweetTraits.push(...response.traits.map(t => t as TweetTrait));

    return state;
  }
};