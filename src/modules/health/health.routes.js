import { Router } from 'express';

const router = Router();

/**
 * GET /api/health
 * A lightweight endpoint used to confirm that the process is up and accepting
 * requests. It does not touch the database or any external service on purpose.
 */
router.get('/', (_req, res) => {
  res.status(200).json({
    success: true,
    message: 'PizzaHub server is running',
    timestamp: new Date().toISOString(),
  });
});

export default router;
