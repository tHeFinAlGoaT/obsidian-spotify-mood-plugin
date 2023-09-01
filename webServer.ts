import express, { Request, Response } from 'express';

const inMemoryStore: { code?: string } = {};

export function startWebServer(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const app = express();
    const PORT = 5500;

    app.get('/callback', (req: Request, res: Response) => {
      inMemoryStore.code = req.query.code as string;
      console.log('Received authorization code:', inMemoryStore.code, 'WARNING: Do not share this code!');
      res.send('<script>window.close();</script>');
    });

    const server = app.listen(PORT, () => {
      console.log(`Web server is running on port ${PORT}`);
      resolve(); // Resolve the promise when the server starts successfully
    });

    server.on('error', (err) => {
      reject(err); // Reject the promise if there's an error starting the server
    });
  });
}

export function getAuthorizationCode(): Promise<string> {
  return new Promise((resolve) => {
    if (inMemoryStore.code) {
      resolve(inMemoryStore.code);
    } else {
      setTimeout(async () => {
        const code = await getAuthorizationCode(); // Await the recursive call
        resolve(code);
      }, 500);
    }
  });
}