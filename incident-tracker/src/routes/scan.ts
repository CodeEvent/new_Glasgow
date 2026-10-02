import { Router, type Request, type Response } from 'express';
import { stewardAuth } from '../middleware/stewardAuth';
import { handleScanRequest, handleTicketLookup } from '../services/scanApi';

export const scanRouter = Router();

scanRouter.post('/scan', stewardAuth, async (req: Request, res: Response) => {
  const { status, body } = await handleScanRequest(req.body);
  res.status(status).json(body);
});

/** Read-only pre-check by seat: /api/tickets/lookup?section=112&row=F&seat=14 (optionally &ticket_id=...). */
scanRouter.get('/tickets/lookup', stewardAuth, async (req: Request, res: Response) => {
  const { status, body } = await handleTicketLookup(req.query);
  res.status(status).json(body);
});

/** Read-only pre-check the intake form calls straight after the QR is scanned. */
scanRouter.get('/tickets/:ticketId', stewardAuth, async (req: Request, res: Response) => {
  const { status, body } = await handleTicketLookup({ ticket_id: req.params.ticketId });
  res.status(status).json(body);
});
