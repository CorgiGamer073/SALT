'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { ACTOR_ROLE_LOCK_NAMESPACE, normalizeUserIds, lockPgUserRoleMutations } = require('../../utils/roleMutationLocks');

// Match link-admin/account deletion: resolve accounts and acquire sorted user
// advisory fences BEFORE any guild or guild_roles row lock. Never update a user
// under a tenant lock (that inverts account deletion's users -> guild_roles order).
async function resolveSetupUsersAndLock(client, profiles) {
  const unique = [...new Map(profiles.map(profile => [profile.discordId, profile])).values()]
    .sort((a, b) => a.discordId.localeCompare(b.discordId));
  const existing = await client.query(
    'SELECT id, discord_id FROM users WHERE discord_id = ANY($1::TEXT[])',
    [unique.map(profile => profile.discordId)]
  );
  const users = new Map(existing.rows.map(user => [user.discord_id, user]));
  const hadMissingUsers = unique.some(profile => !users.has(profile.discordId));
  // Resolve every missing identity before taking ANY advisory fence: a unique
  // conflict can itself wait on a peer needing one of those fences, and the
  // winner's preallocated ID need not be larger than existing IDs.
  for (const profile of unique) {
    if (users.has(profile.discordId)) continue;
    let resolved = await client.query(
      `INSERT INTO users (discord_id, username, avatar)
       VALUES ($1, $2, $3) ON CONFLICT (discord_id) DO NOTHING
       RETURNING id, discord_id`,
      [profile.discordId, profile.username || null, profile.avatar || null]
    );
    if (!resolved.rows.length) {
      resolved = await client.query('SELECT id, discord_id FROM users WHERE discord_id = $1', [profile.discordId]);
    }
    const user = resolved.rows[0];
    if (!user || user.discord_id !== profile.discordId) throw new Error('Unable to resolve Discord setup user');
    users.set(profile.discordId, user);
  }
  const userIds = [...users.values()].map(user => user.id);
  if (hadMissingUsers) {
    // Inserts may already hold row/unique locks needed by a fenced peer. Never
    // wait for advisory locks here; the caller must roll back the WHOLE attempt
    // on contention, releasing inserted rows and any earlier acquired fences.
    for (const userId of normalizeUserIds(userIds)) {
      const fence = await client.query(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        [ACTOR_ROLE_LOCK_NAMESPACE, userId]
      );
      if (fence.rows[0]?.locked !== true) throw new Error('Discord setup accounts are busy; please retry registration');
    }
  } else {
    await lockPgUserRoleMutations(client, userIds);
  }
  // An account may have been removed/recreated while waiting for its advisory
  // lock. Do not repair or silently switch internal identities on this attempt.
  const current = await client.query(
    'SELECT id, discord_id FROM users WHERE discord_id = ANY($1::TEXT[])',
    [unique.map(profile => profile.discordId)]
  );
  if (current.rows.length !== unique.length || current.rows.some(user => users.get(user.discord_id)?.id !== user.id)) {
    throw new Error('Discord setup account changed during registration');
  }
  for (const profile of unique) {
    const user = users.get(profile.discordId);
    const refreshed = await client.query(
      'UPDATE users SET username = $2, avatar = $3 WHERE id = $1 AND discord_id = $4',
      [user.id, profile.username || null, profile.avatar || null, profile.discordId]
    );
    if (refreshed.rowCount !== 1) throw new Error('Discord setup account changed during registration');
  }
  return users;
}

function isEligibleInitialGuildOwner(permission) {
  return Boolean(permission && (permission.isGuildOwner || permission.hasAdministrator));
}

function canRegisterExistingGuildToken(role, ownerCount) {
  return ownerCount === 1 && (role === 'owner' || role === 'admin');
}

async function getDiscordSetupPermission(interaction) {
  const actorDiscordId = String(interaction?.user?.id || '');
  const guildId = String(interaction?.guild?.id || '');
  if (!actorDiscordId || !guildId) {
    throw new Error('Discord guild membership context is unavailable');
  }
  const refreshedGuild = await interaction?.client?.guilds.fetch({
    guild: interaction?.guild?.id,
    force: true,
    cache: false,
  });
  if (String(refreshedGuild?.id || '') !== guildId) {
    throw new Error('Discord returned an unexpected guild identity');
  }
  const ownerDiscordId = String(refreshedGuild?.ownerId || '');
  if (!ownerDiscordId) {
    throw new Error('Discord guild owner context is unavailable');
  }
  const [member, ownerMember] = await Promise.all([
    refreshedGuild.members.fetch({ user: actorDiscordId, force: true, cache: false }),
    refreshedGuild.members.fetch({ user: ownerDiscordId, force: true, cache: false }),
  ]);
  if (String(member?.guild?.id || '') !== guildId ||
      String(ownerMember?.guild?.id || '') !== guildId ||
      String(member?.user?.id || member?.id || '') !== actorDiscordId ||
      String(ownerMember?.user?.id || ownerMember?.id || '') !== ownerDiscordId) {
    throw new Error('Discord returned an unexpected guild member identity');
  }
  return {
    isGuildOwner: ownerDiscordId === actorDiscordId,
    hasAdministrator: Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator)),
    authoritativeOwner: ownerMember?.user ? {
      discordId: String(ownerMember.user.id),
      username: ownerMember.user.username,
      avatar: ownerMember.user.avatar || null,
    } : null,
  };
}

function selectInitialGuildOwner(permission) {
  return permission?.authoritativeOwner || null;
}

async function ensureAuthoritativeInitialGuildOwner(client, {
  guildId,
  actorUserId,
  ownerUserId,
  owner,
  assignIfMissing,
}) {
  if (!client || !guildId || !actorUserId || !owner?.discordId) {
    throw new Error('Authoritative guild owner assignment context is incomplete');
  }

  if (assignIfMissing) {
    if (!ownerUserId) throw new Error('Resolve and lock the authoritative Discord owner before tenant locks');
    const roleWrite = await client.query(
      `INSERT INTO guild_roles (guild_id, user_id, role, assigned_by)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT (guild_id, user_id) DO UPDATE SET
         role = EXCLUDED.role,
         assigned_by = EXCLUDED.assigned_by,
         assigned_at = CURRENT_TIMESTAMP
       RETURNING user_id`,
      [guildId, ownerUserId, actorUserId]
    );
    if (roleWrite.rowCount !== 1 || roleWrite.rows[0]?.user_id !== ownerUserId) {
      throw new Error('Unable to assign the authoritative Discord guild owner');
    }
  }

  const ownerRows = await client.query(
    `SELECT gr.user_id, u.discord_id
       FROM guild_roles gr
       JOIN users u ON u.id = gr.user_id
      WHERE gr.guild_id = $1 AND gr.role = 'owner'
      FOR UPDATE OF gr`,
    [guildId]
  );
  if (ownerRows.rows.length !== 1 ||
      String(ownerRows.rows[0].discord_id) !== String(owner.discordId)) {
    throw new Error('Tenant ownership does not match the authoritative Discord guild owner');
  }
  return ownerRows.rows[0].user_id;
}

module.exports = {
  resolveSetupUsersAndLock,
  canRegisterExistingGuildToken,
  ensureAuthoritativeInitialGuildOwner,
  getDiscordSetupPermission,
  isEligibleInitialGuildOwner,
  selectInitialGuildOwner,
};
