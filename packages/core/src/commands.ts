/**
 * The `/standup` slash command — its definition, its window logic, and a
 * transport-agnostic handler.
 *
 * The handler talks to a narrow `StandupInteraction` interface, not to
 * discord.js, so the real product logic (parse options → build → respond) is
 * unit-tested with a fake interaction and a fake builder — no gateway, no
 * network. `src/bot.ts` is the thin discord.js adapter that satisfies the
 * interface with a real `ChatInputCommandInteraction`.
 */
import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import type { Config, Secrets } from './config.js';
import { buildStandup as buildStandupImpl } from './standup.js';
import { buildAnswer as buildAnswerImpl } from './ask.js';
import { standupEmbeds as standupEmbedsImpl, type StandupEmbed } from './discord.js';
import { configFeatureFlags, noopTracker, type Tracker } from './telemetry.js';
import { resolveOctokit } from './github-auth.js';
import { reviewPrByNumber } from './pr-review.js';

export const STANDUP_COMMAND_NAME = 'standup';
export const ASK_COMMAND_NAME = 'ask';
export const OPENPR_COMMAND_NAME = 'openpr';
export const DASH_COMMAND_NAME = 'dash';
export const PR_COMMAND_NAME = 'pr';
// Four existing guild commands plus /pr leave 95 chat-input names.
const MAX_NUMBERED_PR_COMMAND = 95;

export function numberedPrCommand(command: string): number | null {
  const match = /^pr([1-9][0-9]?)$/.exec(command);
  const number = Number(match?.[1]);
  return number <= MAX_NUMBERED_PR_COMMAND ? number : null;
}

export async function handlePrCommand(
  ix: StandupInteraction, config: Config, secrets: Secrets, aliasNumber: number | null = null, review = reviewPrByNumber,
): Promise<void> {
  await ix.defer(false);
  const number = aliasNumber ?? ix.getInteger('번호');
  const repo = ix.getString('저장소') ?? (config.repos.length === 1 ? config.repos[0] : undefined);
  if (number === null || !Number.isSafeInteger(number) || number < 1) {
    await ix.respondError('PR 번호를 입력해 주세요. 예: /pr 번호:13');
    return;
  }
  if (!repo || !config.repos.includes(repo)) {
    await ix.respondError('이 봇에 연결된 저장소 이름을 저장소 옵션에 입력해 주세요.');
    return;
  }
  try {
    await ix.respond(standupEmbedsImpl(await review(config, secrets, number, repo)));
  } catch {
    await ix.respondError(`#${number} PR 리뷰에 실패했어요. 잠시 후 다시 시도해 주세요.`);
  }
}

export async function handleOpenPrCommand(
  ix: StandupInteraction,
  config: Config,
  secrets: Secrets,
  getClient = resolveOctokit,
): Promise<void> {
  await ix.defer(false);
  if (config.discord.standupStartAt && Date.now() < Date.parse(config.discord.standupStartAt)) {
    await ix.respond(standupEmbedsImpl('대회 시작 후 열린 PR을 확인할 수 있어요.'));
    return;
  }

  try {
    if (!config.repos.length) throw new Error('No repositories configured');
    const github = await getClient(config, secrets);
    const rows: { number: number; text: string }[] = [];
    for (const repo of config.repos) {
      const target = { owner: config.org, repo };
      const open = await github.paginate(github.rest.pulls.list, { ...target, state: 'open', per_page: 100 });
      for (const pull of open) {
        const { data } = await github.rest.pulls.get({ ...target, pull_number: pull.number });
        if (data.state !== 'open') continue;
        const status = data.mergeable === false ? '충돌'
          : data.draft ? '초안'
          : data.mergeable === null ? '확인 중' : '열림';
        rows.push({ number: data.number, text: `- [#${data.number}](${data.html_url}) · ${status}` });
      }
    }
    rows.sort((a, b) => b.number - a.number);
    const report = rows.length ? `열린 PR ${rows.length}개\n${rows.map((row) => row.text).join('\n')}` : '현재 열린 PR이 없어요.';
    await ix.respond(standupEmbedsImpl(report));
  } catch {
    await ix.respondError('GitHub에서 열린 PR을 확인하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
}

/** Preset ranges the picker offers → window length in hours. */
const RANGE_HOURS: Record<string, number> = {
  today: 24,
  week: 168,
  month: 720, // ~30 days
};

const MIN_DAYS = 1;
const MAX_DAYS = 90;

/** The `/standup` command definition: a preset range picker + a custom-days escape hatch. */
export function buildStandupCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(STANDUP_COMMAND_NAME)
    .setDescription("Post the team's standup, summarized from GitHub activity")
    // Secure default: admins only. The standup exposes the org's private GitHub
    // activity, so don't let any member of any server the bot joins trigger it.
    // Server admins can broaden access per-command in Server Settings → Integrations.
    .setDefaultMemberPermissions('0');
  cmd.addStringOption((o) =>
    o
      .setName('range')
      .setDescription('Time window (defaults to the configured window)')
      .addChoices(
        { name: 'Today', value: 'today' },
        { name: 'This week', value: 'week' },
        { name: 'This month', value: 'month' },
      ),
  );
  cmd.addIntegerOption((o) =>
    o
      .setName('days')
      .setDescription(`Custom window in days (overrides range), ${MIN_DAYS}–${MAX_DAYS}`)
      .setMinValue(MIN_DAYS)
      .setMaxValue(MAX_DAYS),
  );
  // Report-setting overrides. Omitting an option keeps the configured default;
  // these just let a caller tweak one standup without editing config.
  cmd.addStringOption((o) =>
    o
      .setName('stats')
      .setDescription('Team stats panel (default: auto by window)')
      .addChoices(
        { name: 'On', value: 'on' },
        { name: 'Off', value: 'off' },
        { name: 'Auto (by window)', value: 'auto' },
      ),
  );
  cmd.addBooleanOption((o) =>
    o.setName('per_person').setDescription('Show each person’s stat line (overrides the default)'),
  );
  cmd.addStringOption((o) =>
    o
      .setName('format')
      .setDescription('Per-person style (default: bullets)')
      .addChoices({ name: 'Bullets', value: 'bullets' }, { name: 'Prose', value: 'prose' }),
  );
  return cmd;
}

/** The `/ask` command: a free-text question + the same window controls. */
export function buildAskCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(ASK_COMMAND_NAME)
    .setDescription('Ask Inky about the team’s recent GitHub activity (grounded answer)')
    // Same secure default as /standup — it exposes the org's private activity.
    .setDefaultMemberPermissions('0');
  cmd.addStringOption((o) =>
    o
      .setName('question')
      .setDescription('e.g. “what did alice ship this week?” / “what’s still in flight on api?”')
      .setRequired(true),
  );
  cmd.addStringOption((o) =>
    o
      .setName('range')
      .setDescription('Time window to look at (defaults to the configured window)')
      .addChoices(
        { name: 'Today', value: 'today' },
        { name: 'This week', value: 'week' },
        { name: 'This month', value: 'month' },
      ),
  );
  cmd.addIntegerOption((o) =>
    o
      .setName('days')
      .setDescription(`Custom window in days (overrides range), ${MIN_DAYS}–${MAX_DAYS}`)
      .setMinValue(MIN_DAYS)
      .setMaxValue(MAX_DAYS),
  );
  return cmd;
}

/**
 * Resolve the requested window (hours) from the command options. `days` (clamped
 * to 1–90) wins over `range`; with neither, returns undefined so buildStandup
 * falls back to config.windowHours.
 */
export function resolveCommandWindow(range: string | null, days: number | null): number | undefined {
  if (days != null && Number.isFinite(days)) {
    const clamped = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Math.floor(days)));
    return clamped * 24;
  }
  if (range && range in RANGE_HOURS) return RANGE_HOURS[range];
  return undefined;
}

/** Human label for a resolved window, for log lines. */
export function describeWindow(windowHours: number | undefined): string {
  if (windowHours == null) return 'the configured window';
  if (windowHours % 24 === 0) {
    const days = windowHours / 24;
    return days === 1 ? 'the last day' : `the last ${days} days`;
  }
  return `the last ${windowHours}h`;
}

/**
 * The transport-agnostic view of an interaction the handler needs. The option
 * accessors mirror discord.js, so bot.ts adapts a real ChatInputCommandInteraction
 * with a trivial passthrough and tests pass a fake option bag.
 */
export interface StandupInteraction {
  getString(name: string): string | null;
  getInteger(name: string): number | null;
  getBoolean(name: string): boolean | null;
  /** Who invoked it — for logging only. */
  user: string;
  /**
   * Acknowledge within 3s ("Inky is thinking…") so we can take our time. When
   * `ephemeral`, the entire reply (and any follow-ups) is visible only to the
   * invoker. Discord fixes ephemerality at defer time — it can't change after —
   * so the choice is made here, before the build.
   */
  defer(ephemeral: boolean): Promise<void>;
  /** Post the finished standup. */
  respond(embeds: StandupEmbed[]): Promise<void>;
  /** Report a failure in place of the standup. */
  respondError(message: string): Promise<void>;
}

/** The buildStandup-shaped request parsed from a `/standup` interaction. */
export interface StandupRequest {
  windowHours?: number;
  stats?: boolean;
  statsPerPerson?: boolean;
  format?: 'prose' | 'bullets';
}

/**
 * Parse the command options into a buildStandup request. Every field is an
 * override — left undefined when the option is absent so the configured default
 * applies.
 */
export function resolveStandupRequest(ix: StandupInteraction): StandupRequest {
  const windowHours = resolveCommandWindow(ix.getString('range'), ix.getInteger('days'));

  const statsOpt = ix.getString('stats'); // 'on' | 'off' | 'auto' | null
  const stats = statsOpt === 'on' ? true : statsOpt === 'off' ? false : undefined;

  const perPerson = ix.getBoolean('per_person');
  const statsPerPerson = perPerson === null ? undefined : perPerson;

  const fmt = ix.getString('format'); // 'bullets' | 'prose' | null
  const format = fmt === 'prose' ? 'prose' : fmt === 'bullets' ? 'bullets' : undefined;

  return { windowHours, stats, statsPerPerson, format };
}

export interface StandupCommandDeps {
  buildStandup?: typeof buildStandupImpl;
  standupEmbeds?: typeof standupEmbedsImpl;
  log?: (msg: string) => void;
  /** Anonymous usage telemetry (opt-in). Defaults to the inert noop tracker. */
  telemetry?: Tracker;
}

/**
 * Handle one `/standup` invocation: ack, build the standup for the requested
 * window, and respond with it. Any failure is reported in place rather than
 * leaving the interaction hanging on "thinking…".
 */
export async function handleStandupCommand(
  ix: StandupInteraction,
  config: Config,
  secrets: Secrets,
  deps: StandupCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? (() => {});
  const telemetry = deps.telemetry ?? noopTracker;
  const build = deps.buildStandup ?? buildStandupImpl;
  const toEmbeds = deps.standupEmbeds ?? standupEmbedsImpl;
  const req = resolveStandupRequest(ix);
  const startAt = req.windowHours === undefined ? config.discord.standupStartAt : undefined;
  const requestedAt = new Date();

  await ix.defer(false); // building takes ~seconds; Discord wants an ack within 3
  try {
    const elapsedHours = startAt ? (requestedAt.getTime() - Date.parse(startAt)) / 3_600_000 : undefined;
    if (elapsedHours !== undefined && elapsedHours <= 0) {
      await ix.respond(toEmbeds('대회 시작 후 누적 진행 상황을 확인할 수 있어요.'));
      return;
    }
    const built = await build(config, secrets, {
      ...req,
      ...(elapsedHours !== undefined && {
        now: requestedAt,
        windowHours: elapsedHours,
        title: '📋 대회 누적 진행 상황',
      }),
      log,
    });
    // Anonymous: a /standup command ran, its window + coarse flags.
    void telemetry.track('standup_run', {
      trigger: 'command',
      windowHours: elapsedHours ?? req.windowHours ?? config.windowHours,
      dryRun: false,
      private: false,
      ...configFeatureFlags(config),
    });
    await ix.respond(toEmbeds(built.markdown));
    log(
      `inky: /standup answered for ${ix.user} (${startAt ? 'since contest start' : describeWindow(req.windowHours)}).`,
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`inky: /standup failed for ${ix.user}: ${message}`);
    // Keep the channel-facing text short and single-line — never dump a raw API
    // response body into the channel. The full message is in the logs above.
    const safe = message.replace(/\s+/g, ' ').slice(0, 200);
    try {
      await ix.respondError(`⚠️ Couldn't build the standup: ${safe}`);
    } catch (replyErr) {
      log(`inky: failed to send the error reply: ${(replyErr as Error).message}`);
    }
  }
}

export interface AskCommandDeps {
  buildAnswer?: typeof buildAnswerImpl;
  standupEmbeds?: typeof standupEmbedsImpl;
  log?: (msg: string) => void;
  /** Anonymous usage telemetry (opt-in). Defaults to the inert noop tracker. */
  telemetry?: Tracker;
}

/**
 * Handle one `/ask` invocation: ack, build a grounded answer for the requested
 * window, respond with it. Mirrors handleStandupCommand — same defer/respond/
 * error discipline, reusing the standup→embeds renderer for the answer markdown.
 */
export async function handleAskCommand(
  ix: StandupInteraction,
  config: Config,
  secrets: Secrets,
  deps: AskCommandDeps = {},
): Promise<void> {
  const log = deps.log ?? (() => {});
  const telemetry = deps.telemetry ?? noopTracker;
  const build = deps.buildAnswer ?? buildAnswerImpl;
  const toEmbeds = deps.standupEmbeds ?? standupEmbedsImpl;

  const question = (ix.getString('question') ?? '').trim();
  const windowHours = resolveCommandWindow(ix.getString('range'), ix.getInteger('days'));

  await ix.defer(false);
  try {
    if (!question) {
      // Discord enforces the required option, but the handler is tested directly —
      // keep the guard inside try so a failing respondError is caught + logged,
      // not left as a stranded deferral.
      await ix.respondError('⚠️ Ask a question, e.g. `/ask question: what did the team ship this week?`');
      return;
    }
    const built = await build(config, secrets, { question, windowHours, log });
    // Anonymous: a question was asked, its window, and whether it was answerable.
    // NEVER the question text or any content.
    void telemetry.track('ask_run', {
      trigger: 'command',
      windowHours: windowHours ?? config.windowHours,
      grounded: built.grounded,
      private: false,
    });
    await ix.respond(toEmbeds(built.markdown));
    log(
      `inky: /ask answered for ${ix.user} (${describeWindow(windowHours)}${built.grounded ? '' : ', not answerable from the window'}).`,
    );
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    log(`inky: /ask failed for ${ix.user}: ${message}`);
    const safe = message.replace(/\s+/g, ' ').slice(0, 200);
    try {
      await ix.respondError(`⚠️ Couldn't answer that: ${safe}`);
    } catch (replyErr) {
      log(`inky: failed to send the error reply: ${(replyErr as Error).message}`);
    }
  }
}

export interface RegisterOptions {
  applicationId: string;
  /** Register to one guild (instant) when set; otherwise globally (~1h to appear). */
  guildId?: string;
  token: string;
  dashboardLink?: boolean;
  log?: (msg: string) => void;
  /** Injectable transport for tests; defaults to discord.js REST.put. */
  put?: (route: string, body: unknown) => Promise<void>;
}

/** Register the slash commands with Discord, guild-scoped or global. */
export async function registerCommands(opts: RegisterOptions): Promise<void> {
  const log = opts.log ?? (() => {});
  const openPr = new SlashCommandBuilder().setName(OPENPR_COMMAND_NAME).setDescription('열린 PR 번호와 상태를 확인합니다');
  const pr = new SlashCommandBuilder().setName(PR_COMMAND_NAME).setDescription('PR 번호로 Codex 리뷰를 요청합니다')
    .addIntegerOption((option) => option.setName('번호').setDescription('리뷰할 PR 번호').setMinValue(1).setRequired(true))
    .addStringOption((option) => option.setName('저장소').setDescription('여러 저장소가 연결된 경우 저장소 이름'));
  const body = [buildStandupCommand().toJSON(), buildAskCommand().toJSON(), openPr.toJSON(), pr.toJSON()];
  if (opts.dashboardLink && opts.guildId) {
    body.push(new SlashCommandBuilder().setName(DASH_COMMAND_NAME)
      .setDescription('팀 대시보드 링크를 보여줍니다').toJSON());
    for (let number = 1; number <= MAX_NUMBERED_PR_COMMAND; number++) {
      body.push(new SlashCommandBuilder().setName(`pr${number}`).setDescription(`#${number} PR을 Codex로 리뷰합니다`).toJSON());
    }
  }
  const put =
    opts.put ??
    (async (route: string, payload: unknown) => {
      const rest = new REST({ version: '10' }).setToken(opts.token);
      await rest.put(route as `/${string}`, { body: payload });
    });

  const route = opts.guildId
    ? Routes.applicationGuildCommands(opts.applicationId, opts.guildId)
    : Routes.applicationCommands(opts.applicationId);
  await put(route, body);
  const names = body.filter(({ name }) => numberedPrCommand(name) === null).map(({ name }) => `/${name}`).join(', ')
    + (opts.dashboardLink && opts.guildId ? `, /pr1–/pr${MAX_NUMBERED_PR_COMMAND}` : '');
  log(`inky: registered ${names} ${opts.guildId ? `to guild ${opts.guildId}` : 'globally'}.`);
}
