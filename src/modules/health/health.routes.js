const { Router } = require('express');
const healthController = require('./health.controller');

const router = Router();

router.get('/live', healthController.liveness);
router.get('/ready', healthController.readiness);
router.get('/', healthController.legacyHealth);

module.exports = router;
