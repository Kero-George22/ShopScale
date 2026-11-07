const { Router } = require('express');
const reportController = require('./report.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { createReportSchema } = require('./report.validation');

const router = Router();

// All report routes require authentication
router.use(authenticate);

router.post('/', validate(createReportSchema), reportController.createReport);
router.get('/', reportController.listReports);
router.get('/:id', reportController.getReport);

module.exports = router;
