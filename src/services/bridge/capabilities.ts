import { runShell } from '@services/workspace/shell.ts';
import { ChannelType, type Client, type Guild, type GuildMember, type TextChannel } from 'discord.js';

export type Risk = 'read' | 'reversible' | 'destructive' | 'admin';

export type ParamKind = 'string' | 'number' | 'boolean' | 'string[]';

export type ParamSpec = {
  name: string;
  kind: ParamKind;
  description: string;
  required?: boolean;
  choices?: string[];
};

export type CapabilityContext = {
  client: Client;
  guild: Guild;
  actorId: string;
  channelId?: string;
};

export type Capability = {
  name: string;
  summary: string;
  description: string;
  risk: Risk;
  params: ParamSpec[];
  run: (ctx: CapabilityContext, args: Record<string, unknown>) => Promise<string>;
};

const str = (args: Record<string, unknown>, key: string): string | undefined => {
  const value = args[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

const num = (args: Record<string, unknown>, key: string): number | undefined => {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const requireStr = (args: Record<string, unknown>, key: string): string => {
  const value = str(args, key);
  if (!value) throw new Error(`missing required argument: ${key}`);
  return value;
};

/**
 * Discord audits happen in Discord itself; this wrapper just makes the id/name formatting consistent
 * across capabilities so tool output stays skimmable inside a Discord message.
 */
const describeGuild = (guild: Guild) =>
  [
    `guild: ${guild.name} (${guild.id})`,
    `members: ${guild.memberCount}`,
    `owner: ${guild.ownerId}`,
    `created: ${guild.createdAt.toISOString()}`,
    `channels: ${guild.channels.cache.size}  roles: ${guild.roles.cache.size}  boost tier: ${guild.premiumTier}`,
  ].join('\n');

const resolveTextChannel = (guild: Guild, id: string): TextChannel => {
  const channel = guild.channels.cache.get(id);
  if (!channel) throw new Error(`channel ${id} not found in this guild`);
  if (!channel.isTextBased() || channel.isThread() || channel.isVoiceBased())
    if (!('send' in channel)) throw new Error(`channel ${id} (${channel.name}) cannot hold messages`);

  return channel as TextChannel;
};

const resolveMember = async (guild: Guild, id: string): Promise<GuildMember> => {
  const cached = guild.members.cache.get(id);
  if (cached) return cached;
  return guild.members.fetch(id);
};

const channelLine = (channel: {
  id: string;
  name: string;
  type: ChannelType;
  parentId: string | null;
  position?: number;
}) =>
  `${ChannelType[channel.type] ?? channel.type}  ${channel.id}  #${channel.name}` +
  (channel.parentId ? `  parent=${channel.parentId}` : '') +
  (channel.position === undefined ? '' : `  pos=${channel.position}`);

export const capabilities: Capability[] = [
  {
    'name': 'guild_info',
    'summary': 'Server overview',
    'description': 'Get the name, id, member count, owner, creation date, and channel/role counts of this server.',
    'risk': 'read',
    'params': [],
    'run': async ctx => describeGuild(ctx.guild),
  },
  {
    'name': 'channels_list',
    'summary': 'List channels',
    'description': 'List channels in this server with type, id, name, parent category, and position. Max 200 shown.',
    'risk': 'read',
    'params': [],
    'run': async ctx =>
      [...ctx.guild.channels.cache.values()]
        .sort((a, b) => ('position' in a ? a.position : 0) - ('position' in b ? b.position : 0))
        .slice(0, 200)
        .map(channelLine)
        .join('\n') || 'no channels',
  },
  {
    'name': 'channel_info',
    'summary': 'Channel details',
    'description': 'Get details for one channel: type, topic, position, parent, slowmode, and permission overwrites.',
    'risk': 'read',
    'params': [{ 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true }],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const overwrites =
        'permissionOverwrites' in channel
          ? channel.permissionOverwrites.cache
              .map(
                o => `  ${o.type === 0 ? 'role' : 'member'} ${o.id}: allow=${o.allow.bitfield} deny=${o.deny.bitfield}`,
              )
              .join('\n')
          : '';
      const topic = 'topic' in channel && channel.topic ? `\ntopic: ${channel.topic}` : '';
      return `${channelLine(channel)}${topic}\nrateLimitPerUser: ${'rateLimitPerUser' in channel ? channel.rateLimitPerUser : 'n/a'}\noverwrites:\n${overwrites || '  none'}`;
    },
  },
  {
    'name': 'roles_list',
    'summary': 'List roles',
    'description': 'List roles with id, name, color, position, and whether they are managed/mentionable.',
    'risk': 'read',
    'params': [],
    'run': async ctx =>
      ctx.guild.roles.cache
        .values()
        .toArray()
        .sort((a, b) => b.position - a.position)
        .map(
          role =>
            `${role.id}  @${role.name}  color=${role.hexColor} pos=${role.position}${role.managed ? ' managed' : ''}${role.mentionable ? ' mentionable' : ''}`,
        )
        .join('\n') || 'no roles',
  },
  {
    'name': 'member_list',
    'summary': 'List members',
    'description':
      'List server members (id, username, display name, joined date, roles). Requires the Guild Members intent.',
    'risk': 'read',
    'params': [
      { 'name': 'limit', 'kind': 'number', 'description': 'max members to return (1-200, default 50)' },
      { 'name': 'query', 'kind': 'string', 'description': 'optional username/display prefix filter' },
    ],
    'run': async (ctx, args) => {
      const limit = Math.min(Math.max(num(args, 'limit') ?? 50, 1), 200);
      const members = await ctx.guild.members.fetch({ limit, 'query': str(args, 'query') });
      return (
        [...members.values()]
          .slice(0, limit)
          .map(
            m =>
              `${m.id}  ${m.user.username}${m.nickname ? ` (${m.nickname})` : ''}  joined=${m.joinedAt?.toISOString().slice(0, 10) ?? '?'}  roles=${
                m.roles.cache
                  .filter(r => r.id !== ctx.guild.id)
                  .map(r => r.name)
                  .join(',') || 'none'
              }`,
          )
          .join('\n') || 'no members matched'
      );
    },
  },
  {
    'name': 'member_info',
    'summary': 'Member details',
    'description': "Get one member's id, username, display name, account age, join date, roles, and moderation status.",
    'risk': 'read',
    'params': [{ 'name': 'user_id', 'kind': 'string', 'description': 'user id', 'required': true }],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      return [
        `${member.id}  ${member.user.username}${member.nickname ? ` (${member.nickname})` : ''}`,
        `account created: ${member.user.createdAt.toISOString()}`,
        `joined: ${member.joinedAt?.toISOString() ?? '?'}`,
        `roles: ${
          member.roles.cache
            .filter(r => r.id !== ctx.guild.id)
            .map(r => `${r.name}(${r.id})`)
            .join(', ') || 'none'
        }`,
        `timed out until: ${member.communicationDisabledUntil?.toISOString() ?? 'no'}`,
        `bot: ${member.user.bot}`,
      ].join('\n');
    },
  },
  {
    'name': 'messages_fetch',
    'summary': 'Read recent messages',
    'description':
      'Fetch the most recent messages of a channel (author, timestamp, content) for context or summarising.',
    'risk': 'read',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'limit', 'kind': 'number', 'description': '1-50, default 20' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const limit = Math.min(Math.max(num(args, 'limit') ?? 20, 1), 50);
      const messages = await channel.messages.fetch({ limit });
      return (
        [...messages.values()]
          .reverse()
          .map(
            m =>
              `[${m.createdAt.toISOString()}] ${m.author.username}(${m.author.id}): ${m.content.replace(/\s+/g, ' ').slice(0, 400)}`,
          )
          .join('\n') || 'no messages'
      );
    },
  },
  {
    'name': 'message_send',
    'summary': 'Send a message',
    'description': 'Send a plain message to a channel as the bot.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'content', 'kind': 'string', 'description': 'message text (max 2000 chars)', 'required': true },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const content = requireStr(args, 'content').slice(0, 2000);
      const sent = await channel.send({ content, 'allowedMentions': { 'parse': [] } });
      return `sent message ${sent.id} in #${channel.name}`;
    },
  },
  {
    'name': 'channel_create',
    'summary': 'Create a channel',
    'description': 'Create a text, voice, forum, or category channel, optionally under a parent category.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'channel name', 'required': true },
      {
        'name': 'type',
        'kind': 'string',
        'description': 'text | voice | forum | category (default text)',
        'choices': ['text', 'voice', 'forum', 'category'],
      },
      { 'name': 'parent_id', 'kind': 'string', 'description': 'optional category id' },
      { 'name': 'topic', 'kind': 'string', 'description': 'optional topic for text channels' },
    ],
    'run': async (ctx, args) => {
      const kind = str(args, 'type') ?? 'text';
      const name = requireStr(args, 'name');
      const parent = str(args, 'parent_id') ?? undefined;
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const common = { name, parent, reason };
      const created =
        kind === 'voice'
          ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildVoice })
          : kind === 'forum'
            ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildForum })
            : kind === 'category'
              ? await ctx.guild.channels.create({ ...common, 'type': ChannelType.GuildCategory })
              : kind === 'text'
                ? await ctx.guild.channels.create({
                    ...common,
                    'type': ChannelType.GuildText,
                    'topic': str(args, 'topic'),
                  })
                : undefined;
      if (!created) throw new Error(`unknown channel type: ${kind}`);
      return `created channel ${created.id} #${created.name} (${kind})`;
    },
  },
  {
    'name': 'thread_create',
    'summary': 'Create a thread',
    'description': 'Create a public thread, optionally from an existing message.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel the thread belongs to', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'thread name', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'optional message to start the thread from' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const thread = await channel.threads.create({
        'name': requireStr(args, 'name'),
        'startMessage': str(args, 'message_id') ?? undefined,
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `created thread ${thread.id} (${thread.name})`;
    },
  },
  {
    'name': 'message_delete',
    'summary': 'Delete a message',
    'description': 'Delete one message from a channel. Destructive: content is gone.',
    'risk': 'destructive',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'message id', 'required': true },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const message = await channel.messages.fetch(requireStr(args, 'message_id'));
      await message.delete();
      return `deleted message ${args.message_id} in #${channel.name}`;
    },
  },
  {
    'name': 'role_assign',
    'summary': 'Add/remove a role',
    'description': 'Add or remove one role from one member.',
    'risk': 'reversible',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true },
      { 'name': 'add', 'kind': 'boolean', 'description': 'true to add (default), false to remove' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const roleId = requireStr(args, 'role_id');
      if (roleId === ctx.guild.id) throw new Error('@everyone cannot be assigned');
      const add = args.add !== false;
      if (add) await member.roles.add(roleId, `requested by ${ctx.actorId} via open-discord-agent`);
      else await member.roles.remove(roleId, `requested by ${ctx.actorId} via open-discord-agent`);
      return `${add ? 'added' : 'removed'} role ${roleId} ${add ? 'to' : 'from'} ${member.user.username}`;
    },
  },
  {
    'name': 'member_timeout',
    'summary': 'Time out a member',
    'description': 'Put a member in timeout for N minutes (0 clears). Destructive to their ability to speak.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'minutes', 'kind': 'number', 'description': '1-40320, or 0 to clear', 'required': true },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const minutes = Math.min(Math.max(num(args, 'minutes') ?? 0, 0), 40320);
      await member.timeout(
        minutes === 0 ? null : minutes * 60_000,
        `requested by ${ctx.actorId} via open-discord-agent`,
      );
      return minutes === 0
        ? `cleared timeout for ${member.user.username}`
        : `timed out ${member.user.username} for ${minutes} minutes`;
    },
  },
  {
    'name': 'bash',
    'summary': 'Run a shell command',
    'description':
      'Run a shell command in the workspace. Shadowed builtin: routed through the sandbox (docker by default).',
    'risk': 'destructive',
    'params': [{ 'name': 'command', 'kind': 'string', 'description': 'shell command to execute', 'required': true }],
    'run': async (ctx, args) => runShell(ctx.guild.id, requireStr(args, 'command')),
  },
];

export const capabilityNames = capabilities.map(capability => capability.name);
