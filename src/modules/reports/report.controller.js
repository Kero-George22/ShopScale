const catchAsync = require('../../utils/catchAsync');
const reportService = require('./report.service');

const createReport = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const { type, parameters } = req.body;

  const { report } = await reportService.createReport(userId, { type, parameters });

  res.status(201).json({
    status: 'success',
    data: { report },
  });
});

const getReport = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const { id } = req.params;

  const report = await reportService.getReport(id, userId, userRole);

  res.json({
    status: 'success',
    data: { report },
  });
});

const listReports = catchAsync(async (req, res) => {
  const userId = req.user.id;
  const userRole = req.user.role;
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);

  const result = await reportService.listReports(userId, userRole, { page, limit });

  res.json({
    status: 'success',
    data: result,
  });
});

module.exports = { createReport, getReport, listReports };
