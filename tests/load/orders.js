import http from 'k6/http';
import { check, sleep } from 'k6';

const benchData = JSON.parse(open('./bench-data.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '10s', target: 3 }, // Ramp-up to 3 VUs
    { duration: '25s', target: 6 }, // Sustain 6 VUs
    { duration: '10s', target: 0 }, // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<600'],
  },
};

export function setup() {
  const loginRes = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      email: benchData.user.email,
      password: benchData.user.password,
    }),
    {
      headers: { 'Content-Type': 'application/json' },
    }
  );

  const body = JSON.parse(loginRes.body);
  if (!body.data || !body.data.accessToken) {
    throw new Error('Setup failed: Could not log in benchmark user');
  }

  return { token: body.data.accessToken };
}

export default function (data) {
  const payload = JSON.stringify({
    items: [
      {
        productId: benchData.orderProductId,
        quantity: 1,
      },
    ],
  });

  const idempotencyKey = `bench-vu${__VU}-it${__ITER}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

  const res = http.post(`${BASE_URL}/api/orders`, payload, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.token}`,
      'Idempotency-Key': idempotencyKey,
    },
  });

  check(res, {
    'status is 201': (r) => r.status === 201,
    'order created with id': (r) => {
      try {
        const json = JSON.parse(r.body);
        return json.status === 'success' && Boolean(json.data.order.id);
      } catch (e) {
        return false;
      }
    },
  });

  sleep(0.15);
}
