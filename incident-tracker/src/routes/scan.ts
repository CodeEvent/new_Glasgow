import { Router, type Request, type Response } from 'express';
import { stewardAuth } from '../middleware/stewardAuth';
import { handleScanRequest, handleTicketLookup } from '../services/scanApi';

export const scanRouter = Router();

scanRouter.post('/scan', stewardAuth, async (req: Request, res: Response) => {
  const { status, body } = await handleScanRequest(req.body);
  res.status(status).json(body);
});

/** Read-only pre-check the intake form calls straight after the QR is scanned. */
scanRouter.get('/tickets/:ticketId', stewardAuth, async (req: Request, res: Response) => {
  const { status, body } = await handleTicketLookup(req.params.ticketId);
  res.status(status).json(body);
});
