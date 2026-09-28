import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '10s', target: 5 },  // Ramp-up to 5 VUs
    { duration: '30s', target: 10 }, // Sustain 10 VUs
    { duration: '10s', target: 0 },  // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% errors
    http_req_duration: ['p(95)<500'], // 95% of requests under 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const res = http.get(`${BASE_URL}/api/products?page=1&limit=10`, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'has products list': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === 'success' && Array.isArray(body.data.products);
      } catch (e) {
        return false;
      }
    },
  });

  sleep(0.1);
}
