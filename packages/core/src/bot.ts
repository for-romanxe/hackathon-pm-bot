/**
 * The discord.js gateway adapter for the `/standup` slash command.
 *
 * Thin glue: open a gateway connection, and on each `/standup` interaction adapt
 * the real ChatInputCommandInteraction to the transport-agnostic
 * StandupInteraction the (tested) handler in commands.ts expects. No public URL
 * is needed — the bot connects outbound, so it runs anywhere `serve` runs.
 *
 * Slash-command interactions arrive over the gateway with no privileged intents,
 * so we request only `Guilds`.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Interaction,
} from 'discord.js';
import type { Config, Secrets } from './config.js';
import {
  ASK_COMMAND_NAME,
  DASH_COMMAND_NAME,
  handleAskCommand,
  handleOpenPrCommand,
  handlePrCommand,
  handleStandupCommand,
  OPENPR_COMMAND_NAME,
  PR_COMMAND_NAME,
  numberedPrCommand,
  STANDUP_COMMAND_NAME,
  type StandupInteraction,
} from './commands.js';
import { EMBEDS_PER_MESSAGE } from './discord.js';
import { noopTracker, type Tracker } from './telemetry.js';

export interface BotOptions {
  log?: (msg: string) => void;
  dashboardUrl?: string;
  /** Anonymous usage telemetry (opt-in). Defaults to the inert noop tracker. */
  telemetry?: Tracker;
}

export interface BotHandle {
  stop: () => Promise<void>;
}

/** Connect the gateway bot and start answering `/standup`. */
export async function startBot(
  config: Config,
  secrets: Secrets,
  opts: BotOptions = {},
): Promise<BotHandle> {
  const log = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const telemetry = opts.telemetry ?? noopTracker;
  const token = secrets.discordBotToken;
  if (!token) throw new Error('inky: no DISCORD_BOT_TOKEN set for the /standup bot.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  let reviewingPr = false;

  client.once(Events.ClientReady, (c) => {
    log(`inky: bot online as ${c.user.tag}. /standup, /ask, /openpr and /pr are ready.`);
  });

  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const command = interaction.commandName;
    const aliasNumber = numberedPrCommand(command);
    const prReview = command === PR_COMMAND_NAME || aliasNumber !== null;
    const dashboard = command === DASH_COMMAND_NAME && Boolean(config.discord.guildId && config.discord.channelId);
    if (!dashboard && command !== STANDUP_COMMAND_NAME && command !== ASK_COMMAND_NAME && command !== OPENPR_COMMAND_NAME && !prReview) return;
    // This listener is fire-and-forget: an unhandled rejection here would crash
    // the process (Node's default), so contain everything.
    try {
      const { guildId, channelId } = config.discord;
      if ((guildId && interaction.guildId !== guildId) ||
          (channelId && interaction.channelId !== channelId)) {
        await interaction.reply({ content: '이 명령은 지정된 팀 알림 채널에서 사용할 수 있어요.', flags: MessageFlags.Ephemeral });
        return;
      }
      if (dashboard) {
        await interaction.reply({
          content: opts.dashboardUrl
            ? `[팀 대시보드 열기](<${opts.dashboardUrl}>)`
            : '아직 대시보드 링크가 준비되지 않았어요.',
        });
        return;
      }
      const ix = adapt(interaction, log);
      if (command === ASK_COMMAND_NAME) {
        await handleAskCommand(ix, config, secrets, { log, telemetry });
      } else if (command === OPENPR_COMMAND_NAME) {
        await handleOpenPrCommand(ix, config, secrets);
      } else if (prReview) {
        if (!guildId || !channelId) {
          await interaction.reply({ content: 'PR 리뷰는 설정된 팀 알림 채널에서 사용할 수 있어요.', flags: MessageFlags.Ephemeral });
          return;
        }
        if (reviewingPr) {
          await interaction.reply({ content: '다른 PR 리뷰가 진행 중이에요. 잠시 후 다시 요청해 주세요.' });
          return;
        }
        reviewingPr = true;
        try {
          await handlePrCommand(ix, config, secrets, aliasNumber);
        } finally {
          reviewingPr = false;
        }
      } else {
        await handleStandupCommand(ix, config, secrets, { log, telemetry });
      }
    } catch (err) {
      log(`inky: /${command} handler error: ${(err as Error).message}`);
    }
  });

  client.on(Events.Error, (err) => log(`inky: bot error: ${err.message}`));

  await client.login(token);
  return {
    stop: async () => {
      await client.destroy();
      log('inky: bot stopped.');
    },
  };
}

/** Adapt a real discord.js interaction to the handler's narrow view. */
function adapt(interaction: ChatInputCommandInteraction, log: (msg: string) => void): StandupInteraction {
  // Set at defer time and reused for follow-ups: the deferred reply (and its
  // editReply) is already ephemeral, but each follow-up must opt in explicitly.
  let ephemeral = false;
  return {
    getString: (name) => interaction.options.getString(name),
    getInteger: (name) => interaction.options.getInteger(name),
    getBoolean: (name) => interaction.options.getBoolean(name),
    user: interaction.user.username,
    defer: async (eph) => {
      ephemeral = eph;
      await interaction.deferReply(eph ? { flags: MessageFlags.Ephemeral } : {});
    },
    respond: async (embeds) => {
      // editReply takes the first batch; the rest go as follow-ups (10/message).
      // A follow-up failure shouldn't unwind into the build-error path and post
      // "couldn't build the standup" on top of an already-delivered standup.
      await interaction.editReply({ embeds: embeds.slice(0, EMBEDS_PER_MESSAGE) });
      for (let i = EMBEDS_PER_MESSAGE; i < embeds.length; i += EMBEDS_PER_MESSAGE) {
        try {
          await interaction.followUp({
            embeds: embeds.slice(i, i + EMBEDS_PER_MESSAGE),
            ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          });
        } catch (err) {
          log(`inky: follow-up embed batch failed: ${(err as Error).message}`);
        }
      }
    },
    respondError: async (message) => {
      await interaction.editReply({ content: message });
    },
  };
}
