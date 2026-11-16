import { callRpc, json, readJsonRequest, resolveActor } from './_lib/supabase-core.mjs';

const endpointOk = value => typeof value === 'string' && value.length >= 1 && value.length <= 2048 && /^https:\/\//.test(value);
const keyOk = value => typeof value === 'string' && value.length >= 10 && value.length <= 256;

export default async request => {
  try {
    if (request.method !== 'POST' || request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return json({ error: 'invalid_request' }, 400);
    }
    const actor = await resolveActor(request);
    const body = await readJsonRequest(request, 24 * 1024);
    const action = body.action;
    const subscription = body.subscription || {};
    if (!endpointOk(subscription.endpoint)) return json({ error: 'invalid_subscription' }, 400);
    if (action === 'subscribe') {
      if (!keyOk(subscription.keys?.p256dh) || !keyOk(subscription.keys?.auth)) return json({ error: 'invalid_subscription' }, 400);
      await callRpc('push_subscription_upsert', {
        p_auth_user_id: actor.authUser.id,
        p_endpoint: subscription.endpoint,
        p_p256dh: subscription.keys.p256dh,
        p_auth: subscription.keys.auth,
        p_user_agent: String(body.userAgent || '').slice(0, 512)
      });
      return json({ ok: true });
    }
    if (action === 'unsubscribe') {
      await callRpc('push_subscription_delete', { p_auth_user_id: actor.authUser.id, p_endpoint: subscription.endpoint });
      return json({ ok: true });
    }
    return json({ error: 'invalid_action' }, 400);
  } catch (error) {
    const status = Number(error?.status) || 500;
    return json({ error: status >= 500 ? 'push_unavailable' : (error?.code || 'request_failed') }, status);
  }
}
