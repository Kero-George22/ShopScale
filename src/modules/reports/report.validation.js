const { z } = require('zod');

const createReportSchema = z.object({
  type: z.enum(['sales_summary'], {
    errorMap: () => ({ message: 'Invalid report type. Supported types: sales_summary' }),
  }),
  parameters: z.object({}).passthrough().optional().default({}),
});

module.exports = { createReportSchema };
