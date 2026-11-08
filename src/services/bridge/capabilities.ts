import { runShell } from '@services/workspace/shell.ts';
import {
  ChannelType,
  PermissionFlagsBits,
  TextChannel as TextChannelClass,
  type Client,
  type ColorResolvable,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';

type PermissionName = keyof typeof PermissionFlagsBits;

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

const strArray = (args: Record<string, unknown>, key: string): string[] => {
  const value = args[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
};

/** Permission names are validated against discord.js's flag table, so a typo fails the call instead of no-oping. */
const permissionNames = (names: string[]): PermissionName[] =>
  names.map(name => {
    if (!(name in PermissionFlagsBits))
      throw new Error(
        `unknown permission "${name}"; expected a name like ViewChannel, SendMessages, ManageMessages, Administrator`,
      );

    return name as PermissionName;
  });

const overwritePayload = (allow: string[], deny: string[]): Partial<Record<PermissionName, boolean>> => {
  const payload: Partial<Record<PermissionName, boolean>> = {};
  for (const name of permissionNames(allow)) payload[name] = true;
  for (const name of permissionNames(deny)) payload[name] = false;
  return payload;
};

/** Colours arrive from the model as text; only #rrggbb is accepted so Discord never gets a bogus value. */
const hexColor = (value: string): ColorResolvable => {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`"${value}" is not a hex colour like #ff8800`);
  return value as ColorResolvable;
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

const resolveThread = (guild: Guild, id: string) => {
  const channel = guild.channels.cache.get(id);
  if (!channel || !channel.isThread()) throw new Error(`${id} is not a thread in this guild`);
  return channel;
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

  {
    'name': 'channel_update',
    'summary': 'Rename or retune a channel',
    'description': 'Change a channel name, topic, slowmode seconds, or NSFW flag. Omitted fields are left alone.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'new channel name' },
      { 'name': 'topic', 'kind': 'string', 'description': 'new topic (text and forum channels)' },
      { 'name': 'slowmode', 'kind': 'number', 'description': 'slowmode in seconds (0-21600)' },
      { 'name': 'nsfw', 'kind': 'boolean', 'description': 'mark the channel age-restricted' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      const name = str(args, 'name');
      const topic = str(args, 'topic');
      const slowmode = num(args, 'slowmode');
      const nsfw = typeof args.nsfw === 'boolean' ? args.nsfw : undefined;
      const textChannel = channel instanceof TextChannelClass ? channel : undefined;

      if (name) {
        await channel.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (topic !== undefined) {
        if (!textChannel) throw new Error('topic can only be set on text channels');
        await textChannel.setTopic(topic, reason);
        changed.push('topic');
      }
      if (slowmode !== undefined) {
        if (!textChannel) throw new Error('slowmode can only be set on text channels');
        const value = Math.min(Math.max(slowmode, 0), 21600);
        await textChannel.setRateLimitPerUser(value, reason);
        changed.push(`slowmode=${value}`);
      }
      if (nsfw !== undefined) {
        if (!('setNSFW' in channel)) throw new Error('this channel type cannot be age-restricted');
        await channel.setNSFW(nsfw, reason);
        changed.push(`nsfw=${nsfw}`);
      }
      if (changed.length === 0) throw new Error('nothing to change: pass name, topic, slowmode, or nsfw');
      return `updated ${channel.name} (${channel.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'channel_move',
    'summary': 'Move or reorder a channel',
    'description': 'Move a channel under a category (or out of one) and/or set its position in the sidebar.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      {
        'name': 'parent_id',
        'kind': 'string',
        'description': 'category id to move under, or "none" to remove the parent',
      },
      { 'name': 'position', 'kind': 'number', 'description': 'zero-based position within its parent' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel || !('setPosition' in channel)) throw new Error('channel not found or cannot be repositioned');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const parent = str(args, 'parent_id');
      const position = num(args, 'position');
      if (parent !== undefined) await channel.setParent(parent === 'none' ? null : parent, { 'reason': reason });

      if (position !== undefined && 'setPosition' in channel)
        await channel.setPosition(Math.max(position, 0), { 'reason': reason });

      return `moved ${channel.name} (${channel.id})${parent !== undefined ? ` parent=${parent}` : ''}${position !== undefined ? ` position=${position}` : ''}`;
    },
  },
  {
    'name': 'channel_delete',
    'summary': 'Delete a channel',
    'description':
      'Delete a channel or category permanently, including its message history. Destructive and irreversible.',
    'risk': 'destructive',
    'params': [{ 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true }],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel) throw new Error('channel not found in this guild');
      const name = channel.name;
      await channel.delete(`requested by ${ctx.actorId} via open-discord-agent`);
      return `deleted channel #${name} (${args.channel_id})`;
    },
  },
  {
    'name': 'permission_set',
    'summary': 'Change channel permissions',
    'description':
      'Set or clear a channel permission overwrite for a role or member. Pass permission names to allow and/or deny, e.g. allow ["ViewChannel"], deny ["SendMessages"].',
    'risk': 'destructive',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'target_id', 'kind': 'string', 'description': 'role or member id', 'required': true },
      { 'name': 'allow', 'kind': 'string[]', 'description': 'permission names to allow' },
      { 'name': 'deny', 'kind': 'string[]', 'description': 'permission names to deny' },
      { 'name': 'clear', 'kind': 'boolean', 'description': 'delete the overwrite entirely instead of editing it' },
    ],
    'run': async (ctx, args) => {
      const channel = ctx.guild.channels.cache.get(requireStr(args, 'channel_id'));
      if (!channel || !('permissionOverwrites' in channel))
        throw new Error('channel not found or has no permission overwrites');
      const targetId = requireStr(args, 'target_id');
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const target = ctx.guild.roles.cache.get(targetId)
        ? `role @${ctx.guild.roles.cache.get(targetId)?.name}`
        : `member ${targetId}`;

      if (args.clear === true) {
        await channel.permissionOverwrites.delete(targetId);
        return `cleared ${target} overwrite on #${channel.name}`;
      }
      const payload = overwritePayload(strArray(args, 'allow'), strArray(args, 'deny'));
      if (Object.keys(payload).length === 0) throw new Error('nothing to apply: pass allow, deny, or clear');
      await channel.permissionOverwrites.edit(targetId, payload, { 'reason': reason });
      return `updated ${target} on #${channel.name}: ${Object.entries(payload)
        .map(([key, value]) => `${key}=${value}`)
        .join(', ')}`;
    },
  },
  {
    'name': 'role_create',
    'summary': 'Create a role',
    'description':
      'Create a role with a name, colour (#rrggbb or "default"), hoist/mentionable flags, and permission names.',
    'risk': 'reversible',
    'params': [
      { 'name': 'name', 'kind': 'string', 'description': 'role name', 'required': true },
      { 'name': 'color', 'kind': 'string', 'description': 'hex colour like #ff8800, or "default"' },
      { 'name': 'hoist', 'kind': 'boolean', 'description': 'show separately in the member list' },
      { 'name': 'mentionable', 'kind': 'boolean', 'description': 'allow @role mentions' },
      { 'name': 'permissions', 'kind': 'string[]', 'description': 'permission names to grant' },
    ],
    'run': async (ctx, args) => {
      const color = str(args, 'color');
      const created = await ctx.guild.roles.create({
        'name': requireStr(args, 'name'),
        'color': color && color !== 'default' ? hexColor(color) : undefined,
        'hoist': args.hoist === true,
        'mentionable': args.mentionable === true,
        'permissions': permissionNames(strArray(args, 'permissions')),
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `created role @${created.name} (${created.id}) color=${created.hexColor}`;
    },
  },
  {
    'name': 'role_update',
    'summary': 'Edit a role',
    'description': 'Rename a role, change its colour, hoist/mentionable flags, or replace its permission set.',
    'risk': 'reversible',
    'params': [
      { 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true },
      { 'name': 'name', 'kind': 'string', 'description': 'new role name' },
      { 'name': 'color', 'kind': 'string', 'description': 'hex colour like #ff8800, or "default"' },
      { 'name': 'hoist', 'kind': 'boolean', 'description': 'show separately in the member list' },
      { 'name': 'mentionable', 'kind': 'boolean', 'description': 'allow @role mentions' },
      { 'name': 'permissions', 'kind': 'string[]', 'description': 'replacement permission set' },
    ],
    'run': async (ctx, args) => {
      const role = ctx.guild.roles.cache.get(requireStr(args, 'role_id'));
      if (!role) throw new Error('role not found in this guild');
      if (role.managed) throw new Error(`@${role.name} is managed by an integration and cannot be edited`);
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      const name = str(args, 'name');
      const color = str(args, 'color');
      if (name) {
        await role.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (color !== undefined) {
        if (color === 'default') await role.setColors({ 'primaryColor': 0 }, reason);
        else await role.setColor(hexColor(color), reason);
        changed.push(`color=${color}`);
      }
      if (typeof args.hoist === 'boolean') {
        await role.setHoist(args.hoist, reason);
        changed.push(`hoist=${args.hoist}`);
      }
      if (typeof args.mentionable === 'boolean') {
        await role.setMentionable(args.mentionable, reason);
        changed.push(`mentionable=${args.mentionable}`);
      }
      const permissions = strArray(args, 'permissions');
      if (permissions.length > 0) {
        await role.setPermissions(permissionNames(permissions), reason);
        changed.push(`permissions=${permissions.length} flags`);
      }
      if (changed.length === 0)
        throw new Error('nothing to change: pass name, color, hoist, mentionable, or permissions');
      return `updated role @${role.name} (${role.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'role_delete',
    'summary': 'Delete a role',
    'description': 'Delete a role permanently; everyone who had it loses it. Destructive and irreversible.',
    'risk': 'destructive',
    'params': [{ 'name': 'role_id', 'kind': 'string', 'description': 'role id', 'required': true }],
    'run': async (ctx, args) => {
      const role = ctx.guild.roles.cache.get(requireStr(args, 'role_id'));
      if (!role) throw new Error('role not found in this guild');
      if (role.managed) throw new Error(`@${role.name} is managed by an integration and cannot be deleted`);
      const name = role.name;
      await role.delete(`requested by ${ctx.actorId} via open-discord-agent`);
      return `deleted role @${name} (${args.role_id})`;
    },
  },
  {
    'name': 'thread_update',
    'summary': 'Archive, lock, or rename a thread',
    'description': 'Archive/unarchive a thread, lock it, or rename it.',
    'risk': 'reversible',
    'params': [
      { 'name': 'thread_id', 'kind': 'string', 'description': 'thread id', 'required': true },
      { 'name': 'archived', 'kind': 'boolean', 'description': 'archive the thread' },
      { 'name': 'locked', 'kind': 'boolean', 'description': 'lock the thread (requires archived)' },
      { 'name': 'name', 'kind': 'string', 'description': 'new thread name' },
    ],
    'run': async (ctx, args) => {
      const thread = resolveThread(ctx.guild, requireStr(args, 'thread_id'));
      const reason = `requested by ${ctx.actorId} via open-discord-agent`;
      const changed: string[] = [];
      if (typeof args.archived === 'boolean') {
        await thread.setArchived(args.archived, reason);
        changed.push(`archived=${args.archived}`);
      }
      if (typeof args.locked === 'boolean') {
        await thread.setLocked(args.locked, reason);
        changed.push(`locked=${args.locked}`);
      }
      const name = str(args, 'name');
      if (name) {
        await thread.setName(name, reason);
        changed.push(`name=${name}`);
      }
      if (changed.length === 0) throw new Error('nothing to change: pass archived, locked, or name');
      return `updated thread ${thread.name} (${thread.id}): ${changed.join(', ')}`;
    },
  },
  {
    'name': 'message_pin',
    'summary': 'Pin or unpin a message',
    'description': 'Pin or unpin one message in a channel.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'message_id', 'kind': 'string', 'description': 'message id', 'required': true },
      { 'name': 'pin', 'kind': 'boolean', 'description': 'true to pin (default), false to unpin' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const message = await channel.messages.fetch(requireStr(args, 'message_id'));
      const pin = args.pin !== false;
      if (pin) await message.pin(`requested by ${ctx.actorId}`);
      else await message.unpin(`requested by ${ctx.actorId}`);
      return `${pin ? 'pinned' : 'unpinned'} message ${message.id} in #${channel.name}`;
    },
  },
  {
    'name': 'invite_create',
    'summary': 'Create an invite',
    'description': 'Create a channel invite link with an optional lifetime and use limit.',
    'risk': 'reversible',
    'params': [
      { 'name': 'channel_id', 'kind': 'string', 'description': 'channel id', 'required': true },
      { 'name': 'max_age', 'kind': 'number', 'description': 'lifetime in seconds (0 = never, default 86400)' },
      { 'name': 'max_uses', 'kind': 'number', 'description': 'use limit (0 = unlimited)' },
    ],
    'run': async (ctx, args) => {
      const channel = resolveTextChannel(ctx.guild, requireStr(args, 'channel_id'));
      const invite = await channel.createInvite({
        'maxAge': Math.max(num(args, 'max_age') ?? 86_400, 0),
        'maxUses': Math.max(num(args, 'max_uses') ?? 0, 0),
        'reason': `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `invite https://discord.gg/${invite.code} for #${channel.name} expires=${invite.expiresAt?.toISOString() ?? 'never'} maxUses=${invite.maxUses}`;
    },
  },
  {
    'name': 'member_kick',
    'summary': 'Kick a member',
    'description': 'Remove a member from the server (they can rejoin with an invite). Destructive.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      { 'name': 'reason', 'kind': 'string', 'description': 'audit-log reason' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const name = member.user.username;
      await member.kick(str(args, 'reason') ?? `requested by ${ctx.actorId} via open-discord-agent`);
      return `kicked ${name} (${member.id})`;
    },
  },
  {
    'name': 'member_ban',
    'summary': 'Ban a member',
    'description':
      'Ban a member and optionally delete their recent messages. Destructive and reversible only by an unban.',
    'risk': 'destructive',
    'params': [
      { 'name': 'user_id', 'kind': 'string', 'description': 'member id', 'required': true },
      {
        'name': 'delete_message_seconds',
        'kind': 'number',
        'description': 'delete this many seconds of their messages (0-604800)',
      },
      { 'name': 'reason', 'kind': 'string', 'description': 'audit-log reason' },
    ],
    'run': async (ctx, args) => {
      const member = await resolveMember(ctx.guild, requireStr(args, 'user_id'));
      const name = member.user.username;
      const seconds = Math.min(Math.max(num(args, 'delete_message_seconds') ?? 0, 0), 604_800);
      await member.ban({
        'deleteMessageSeconds': seconds,
        'reason': str(args, 'reason') ?? `requested by ${ctx.actorId} via open-discord-agent`,
      });
      return `banned ${name} (${member.id}) deletedMessages=${seconds}s`;
    },
  },
];

export const capabilityNames = capabilities.map(capability => capability.name);
