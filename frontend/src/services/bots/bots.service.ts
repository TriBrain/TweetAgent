import { apiGet, apiPost } from "@services/api-base";
import { Bot as BotDTO } from "@x-ai-wallet-bot/common";
import { plainToInstance } from "class-transformer";
import { BehaviorSubject } from "rxjs";
import { backendUrl } from "../backend/backend";
import { Bot } from "./model/bot";

export const bots$ = new BehaviorSubject<Bot[]>([]);
export const activeBot$ = new BehaviorSubject<Bot>(undefined);

export const setActiveBot = (bot:Bot) => {
  activeBot$.next(bot);
  localStorage.setItem("active-bot-id", bot?.id);
}

export const fetchBots = async (): Promise<Bot[]> => {
  const rawBots = await apiGet<BotDTO[]>(`${backendUrl}/bots`, []);

  const bots = plainToInstance(Bot, rawBots, { excludeExtraneousValues: true });
  console.log("Fetched bots:", bots);

  await Promise.all(bots.map(b => b.initialize()));

  bots$.next(bots);

  // Restore previously used bot as active bot
  const storedBotId = localStorage.getItem("active-bot-id");
  const botToRestore = bots?.find(bot => bot.id === storedBotId)
  if (botToRestore)
    setActiveBot(botToRestore);
  else
    setActiveBot(bots?.[0]);

  return bots;
}

export const createBot = async (): Promise<Bot> => {
  const rawBot = await apiPost<BotDTO>(`${backendUrl}/bots`, {}, undefined, "Failed to create bot");
  if (rawBot) {
    const bot = plainToInstance(Bot, rawBot, { excludeExtraneousValues: true });
    await bot.initialize();

    console.log("Bot created:", bot);
    bots$.next([...bots$.value, bot]);
    return bot;
  }

  return undefined;
}

export const getBotById = (botId:string):Bot => {
  return bots$.value.find(bot => bot.id === botId);
}

fetchBots();