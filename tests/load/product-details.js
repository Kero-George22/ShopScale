import http from 'k6/http';
import { check, sleep } from 'k6';

const benchData = JSON.parse(open('./bench-data.json'));
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '10s', target: 5 },  // Ramp-up to 5 VUs
    { duration: '30s', target: 10 }, // Sustain 10 VUs
    { duration: '10s', target: 0 },  // Ramp-down
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
};

export default function () {
  const url = `${BASE_URL}/api/products/${benchData.targetProductId}`;
  const res = http.get(url, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'correct product returned': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.status === 'success' && body.data.product.id === benchData.targetProductId;
      } catch (e) {
        return false;
      }
    },
  });

  sleep(0.1);
}
