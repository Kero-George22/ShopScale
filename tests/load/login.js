import http from 'k6/http';
import { check, sleep } from 'k6';

const benchData = JSON.parse(open('./bench-data.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '10s', target: 3 }, // Ramp-up to 3 VUs
    { duration: '20s', target: 5 }, // Sustain 5 VUs
    { duration: '10s', target: 0 }, // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1500'], // bcrypt is computationally heavy
  },
};

export default function () {
  const payload = JSON.stringify({
    email: benchData.user.email,
    password: benchData.user.password,
  });

  const res = http.post(`${BASE_URL}/api/auth/login`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has accessToken': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === 'success' && Boolean(body.data.accessToken);
      } catch (e) {
        return false;
      }
    },
  });

  sleep(0.2);
}
