import webpush from 'web-push';
import { callRpc, env, json, readJsonRequest, readShared, resolveActor } from './_lib/supabase-core.mjs';

function parsedValue(row) {
  try { return JSON.parse(row?.data?.value || 'null'); } catch (_) { return null; }
}

export default async request => {
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'invalid_request' }, 400);
    const actor = await resolveActor(request);
    const leader = parsedValue(await readShared('weekLeaderId'));
    if (leader !== actor.actorId) return json({ error: 'leader_only' }, 403);
    const body = await readJsonRequest(request, 8 * 1024);
    if (typeof body.notificationId !== 'string' || body.notificationId.length < 1 || body.notificationId.length > 160) return json({ error: 'invalid_notification' }, 400);
    const notifications = parsedValue(await readShared('notifications'));
    const notification = Array.isArray(notifications) ? notifications.find(item => item?.id === body.notificationId) : null;
    if (!notification || typeof notification.message !== 'string') return json({ error: 'notification_not_found' }, 404);
    const target = typeof notification.targetId === 'string' && notification.targetId ? notification.targetId : 'all';
    const rows = await callRpc('push_subscription_targets', { p_target_legacy_id: target });
    const subscriptions = Array.isArray(rows) ? rows : [];
    const publicKey = env('WEB_PUSH_PUBLIC_KEY');
    const privateKey = env('WEB_PUSH_PRIVATE_KEY');
    if (!publicKey || !privateKey) return json({ ok: true, sent: 0, configured: false });
    webpush.setVapidDetails(`mailto:${env('WEB_PUSH_CONTACT') || 'admin@example.invalid'}`, publicKey, privateKey);
    const payload = JSON.stringify({ title: 'طريق الحنابلة', body: `${notification.senderName ? `${notification.senderName}: ` : ''}${notification.message}`, notificationId: notification.id, url: '/' });
    let sent = 0;
    for (const sub of subscriptions.slice(0, 500)) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, { TTL: 86400 });
        sent++;
      } catch (error) {
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          await callRpc('push_subscription_delete', { p_auth_user_id: sub.owner_auth_user_id, p_endpoint: sub.endpoint }).catch(() => {});
        }
      }
    }
    return json({ ok: true, sent, configured: true });
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json({ error: status >= 500 ? 'push_unavailable' : (error?.code || 'request_failed') }, status);
  }
}
