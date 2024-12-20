import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { Bot as DBBot, Prisma, XPost } from '@prisma/client';
import { XPostCreationDTO } from '@x-ai-wallet-bot/common';
import { Subject } from 'rxjs';
import { BotsService } from 'src/bots/bots.service';
import { Bot } from 'src/bots/model/bot';
import { AppLogger } from 'src/logs/app-logger';
import { PrismaService } from 'src/prisma/prisma.service';
import { TwitterService } from 'src/twitter/twitter.service';
import { DispatcherService } from 'src/websockets/dispatcher.service';
import { XAccountsService } from 'src/xaccounts/xaccounts.service';
import { TweetV2 } from 'twitter-api-v2';
import { v4 as uuidV4 } from "uuid";
import { ConversationTree } from './model/conversation-tree';
import { PostStats } from './model/post-stats';
import { XPostWithAccount } from './model/xpost-with-account';

export type OptionalPostCreationInputs = {
  postId?: string;
  publishRequestAt?: Date;
  publishedAt?: Date;
  isSimulated?: boolean;
  parentPostId?: string;
  quotedPostId?: string;
  contestQuotedPostId?: string;
  wasReplyHandled?: boolean;
}

/**
 * Service that provides generic features for X (twitter) posts management.
 * Higher level than the lower level twitter fetch/post API but still independant from
 * specialized bots content.
 */
@Injectable()
export class XPostsService {
  private logger = new AppLogger("XPosts");

  public onPostPublished$ = new Subject<XPost>(); // Sent when a schedule DB post has actually been published on X (X post id becomes known)

  constructor(
    private prisma: PrismaService,
    private twitter: TwitterService,
    private xAccounts: XAccountsService,
    private dispatcher: DispatcherService,
    @Inject(forwardRef(() => BotsService)) private botsService: BotsService
  ) { }

  /**
   * From a child post, retrieves all XPosts that belong to a conversation.
   * A conversation is a list of ordered posts from the root post (no parent) to the current post id.
   * 
   * @param childPostId Post ID on X.
   */
  public async getParentConversation(bot: Bot, childPostId: string): Promise<XPost[]> {
    const conversation: XPost[] = [];

    let currentPostId: string = childPostId;
    while (currentPostId != null) {
      const xPost = await this.prisma.xPost.findFirst({
        where: {
          botId: bot.id,
          postId: currentPostId
        }
      });
      if (!xPost) {
        this.logger.warn(`Could not re-create the whole conversation for twitter post id ${childPostId}. Have all post's parents been fetched well by the fetcher?`);
        return null;
      }

      // Insert at array start
      conversation.splice(0, 0, xPost);

      currentPostId = xPost.parentPostId;
    }

    return conversation;
  }

  /**
   * From the given root post, recursively retrieves child posts and their descendants (database only).
   */
  public async getConversationTree(bot: Bot, post: XPost) {
    const tree = new ConversationTree(post);

    // Get child posts
    const childrenPosts = await this.prisma.xPost.findMany({
      where: {
        botId: bot.id,
        parentPostId: post.postId
      }
    });

    for (const child of childrenPosts) {
      tree.children.push(await this.getConversationTree(bot, child));
    }

    return tree;
  }

  public getXPostByTwitterPostId(bot: DBBot, twitterPostId: string): Promise<XPost> {
    return this.prisma.xPost.findUnique({
      where: {
        botId_postId: {
          botId: bot.id,
          postId: twitterPostId
        }
      },
      include: {
        xAccount: true,
        debugComments: true
      }
    });
  }

  /**
   * Returns the X post most recently published by the given bot.
   */
  public async getMostRecentlyPublishedPost(bot: Bot): Promise<XPost> {
    // Make sure we haven't published too recently
    return this.prisma.xPost.findFirst({
      where: {
        publishRequestAt: { not: null },
        publishedAt: { not: null }
      },
      orderBy: { publishedAt: "desc" }
    });
  }

  /**
   * Sends a queued post in database, that has not been published to twitter yet.
   * In case the original post text is too long, the post is split into sub-tweets and
   * therefore also into sub-posts on our end.
   */
  public async sendNextPendingXPost() {
    // Find a tweet that we can send.
    const postToSend = await this.prisma.xPost.findFirst({
      where: {
        publishRequestAt: { not: null },
        publishedAt: null,
      }
    });

    // Nothing new to send for now
    if (!postToSend)
      return;

    this.logger.log(`Sending tweet (${postToSend.isSimulated ? "simulated" : "live"}) for queued db posted post id ${postToSend.id}`);

    const bot = this.botsService.getBotById(postToSend.botId);
    const botXAccount = await this.xAccounts.ensureXAccount(bot, bot.dbBot.twitterUserId);

    // Handle simulated posts and real X psots differently
    let createdTweets: { postId: string, text: string }[];
    if (postToSend.isSimulated) {
      // Simulaterd posts always remain as a single post, they are not split
      createdTweets = [{ postId: postToSend.postId, text: postToSend.text }];
    }
    else {
      createdTweets = await this.twitter.publishTweet(bot, postToSend.text, postToSend.parentPostId, postToSend.quotedPostId);
    }

    // Mark as sent and create additional DB posts if the tweet has been split (real X posts only) while publishing (because of X post character limitation)
    if (createdTweets && createdTweets.length > 0) {
      const rootTweet = createdTweets[0];
      const updatedPostToSend = await this.updatePost(postToSend.id, {
        bot: { connect: { id: bot.dbBot.id } },
        text: rootTweet.text, // Original post request has possibly been truncated by twitter so we keep what was really published for this post chunk
        postId: rootTweet.postId,
        publishedAt: new Date(),
        xAccount: { connect: { userId: botXAccount.userId } },
        wasReplyHandled: true // directly mark has handled post, as this is our own post
      });

      // Notify this post was published
      this.onPostPublished$.next(updatedPostToSend);

      // Create child xPosts if needed
      let parentPostId = rootTweet.postId;
      for (var tweet of createdTweets.slice(1)) {
        await this.createPost(bot.dbBot, botXAccount.userId, tweet.text, {
          publishedAt: new Date(),
          postId: tweet.postId,
          parentPostId: parentPostId,
          isSimulated: postToSend.isSimulated
        });

        parentPostId = tweet.postId;
      }
    }
  }

  /**
   * Creates a new post in database.
   * Post is not split yes, can be longer than just one tweet. Will be split later
   * when (if) publishing.
   */
  public async createPost(dbBot: DBBot, xAccountId: string, text: string, optValues?: OptionalPostCreationInputs): Promise<XPostWithAccount> {
    const createData: Prisma.XPostCreateArgs["data"] = {
      bot: { connect: { id: dbBot.id } },
      xAccount: { connect: { userId: xAccountId } },
      text: text
    }

    const bot = await this.botsService.getBotById(dbBot.id);

    // Ensure account exists, or throw an error
    const publisherAccount = await this.xAccounts.ensureXAccount(bot, xAccountId);
    if (!publisherAccount)
      throw new Error(`No xAccount with id ${xAccountId} founds, cannot create post!`);

    if (!text)
      throw new Error(`Text is mandatory to create a X post!`);

    if (optValues?.postId) createData.postId = optValues?.postId;
    if (optValues?.parentPostId) createData.parentPostId = optValues?.parentPostId;
    if (optValues?.quotedPostId) createData.quotedPostId = optValues?.quotedPostId;
    if (optValues?.contestQuotedPostId) createData.contestQuotedPost = { connect: { id: optValues?.contestQuotedPostId } };
    if (optValues?.wasReplyHandled) createData.wasReplyHandled = optValues?.wasReplyHandled;

    if (optValues?.isSimulated) {
      if (optValues?.postId)
        throw new Error(`Don't provide postId value for simulated posts. It's defined automatically`);

      createData.isSimulated = optValues?.isSimulated;

      // Overwrite a few data when simulating posts.
      createData.postId = `simulated-${uuidV4()}`
      createData.publishRequestAt = new Date();
      createData.publishedAt = new Date();
    }
    else {
      // Only set when not simulated
      if (optValues?.publishRequestAt) createData.publishRequestAt = optValues?.publishRequestAt;
      if (optValues?.publishedAt) createData.publishedAt = optValues?.publishedAt;
    }

    // If publishing account is our bot, write the bot as handled, no matter what
    if (dbBot.twitterUserId === xAccountId)
      createData.wasReplyHandled = true;

    const post = await this.prisma.xPost.create({
      data: createData,
      include: {
        xAccount: true,
        debugComments: true
      }
    });

    this.emitPostWSUpdate(post);

    return post;
  }

  public async updatePost(id: string, data: Prisma.XPostUpdateArgs["data"]): Promise<XPostWithAccount> {
    const updatedPost = await this.prisma.xPost.update({
      where: { id },
      data,
      include: {
        xAccount: true,
        debugComments: true
      }
    });
    this.emitPostWSUpdate(updatedPost);

    return updatedPost;
  }

  public markReplyHandled(xPost: XPost) {
    return this.updatePost(xPost.id, { wasReplyHandled: true });
  }

  /**
   * Fetches every post not yet in database from twitter api, and saves it to database.
   * API is not called for posts we already know.
   */
  public async fetchAndSaveXPosts(bot: Bot, fetcher: () => Promise<TweetV2[]>): Promise<XPost[]> {
    const posts = await fetcher();

    if (posts) {
      this.logger.log(`Got ${posts.length} posts from twitter api`);

      // Store every post that we don't have yet
      const newPosts: XPost[] = [];
      for (var post of posts) {
        const existingPost = await this.getXPostByTwitterPostId(bot.dbBot, post.id);
        if (!existingPost) {
          this.logger.log('Created database xpost for external X tweetv2:');
          this.logger.log(post);

          const parentPostId = post.referenced_tweets?.find(t => t.type === "replied_to")?.id;
          const quotedPostId = post.referenced_tweets?.find(t => t.type === "quoted")?.id;

          const xAccount = await this.xAccounts.ensureXAccount(bot, post.author_id);

          // Save post to database
          const dbPost = await this.createPost(bot.dbBot, xAccount.userId, post.text, {
            postId: post.id,
            publishedAt: new Date(post.created_at),
            parentPostId,
            quotedPostId,
            isSimulated: false // coming from X api
          });

          newPosts.push(dbPost);
        }
      }

      return newPosts;
    }

    return null;
  }

  public async getLatestPostStats(bot: Bot, postId: string): Promise<PostStats> {
    const postLatest = await this.twitter.fetchSinglePost(bot, postId);

    return {
      impressionCount: postLatest.public_metrics.impression_count,
      likeCount: postLatest.public_metrics.like_count,
      rtCount: postLatest.public_metrics.quote_count + postLatest.public_metrics.retweet_count,
      commentCount: postLatest.public_metrics.reply_count
    }
  }

  /**
   * @param rootPostId the XPost database id, not twitter id
   */
  public async getChildrenPosts(bot: DBBot, rootPostId?: string): Promise<{ root?: XPost, posts: XPost[] }> {
    let root: XPost;
    if (rootPostId) {
      root = await this.prisma.xPost.findFirst({
        where: {
          id: rootPostId
        },
        include: {
          xAccount: true,
          debugComments: true
        }
      });
    }

    let posts: XPost[] = [];
    if (!root || root.publishedAt) {
      // Only fetch child posts if the root post has been published or if no root post
      posts = await this.prisma.xPost.findMany({
        where: {
          botId: bot.id,
          ...(root && { parentPostId: root.postId })
        },
        include: {
          xAccount: true,
          debugComments: true
        },
        orderBy: { createdAt: "desc" }, // Sort by creation date instead of publishing, so we can also see unpublished posts ordered
        take: 50 // For now, no pagination, limit to 50
      });
    }

    return { root, posts };
  }

  /**
   * Manually creates a post (simulated). Helps to test more use cases without depending 
   * on twitter posts/fetches.
   */
  public createManualPost(bot: DBBot, postCreationInput: XPostCreationDTO): Promise<XPost> {
    return this.createPost(bot, postCreationInput.xAccountUserId, postCreationInput.text, {
      isSimulated: true,
      parentPostId: postCreationInput.parentPostId,
      quotedPostId: postCreationInput.quotedPostId,
    });
  }

  public emitPostWSUpdate(post: XPostWithAccount) {
    this.dispatcher.emitPost(post);
  }
}
