import { Writable } from 'stream';
import path from 'path';
import fastifyExpress from 'fastify-express';
import devMiddleware, { WebpackDevMiddleware } from 'webpack-dev-middleware';
import getFilenameFromUrl from 'webpack-dev-middleware/dist/utils/getFilenameFromUrl';
import webpack from 'webpack';
import { isVerbose } from '../env';
import { ReactNativeStackFrame, Symbolicator } from './Symbolicator';
import { BaseDevServer, BaseDevServerConfig } from './BaseDevServer';
import { readFileFromWdm } from './utils/readFileFromWdm';
import { transformFastifyLogToLogEntry } from './utils/transformFastifyLogToWebpackLogEntry';
import { WebSocketHMRServer } from './ws';

export interface DevServerConfig extends BaseDevServerConfig {}

export class DevServer extends BaseDevServer {
  private static getLoggerOptions(
    compiler: webpack.Compiler,
    platform: string
  ) {
    const webpackLogger = compiler.getInfrastructureLogger(
      `DevServer@${platform}`
    );
    const logStream = new Writable({
      write: (chunk, _encoding, callback) => {
        const data = chunk.toString();
        const logEntry = transformFastifyLogToLogEntry(data);
        webpackLogger[logEntry.type](...logEntry.message);
        callback();
      },
    });

    return { stream: logStream, level: isVerbose() ? 'debug' : 'info' };
  }

  wdm: WebpackDevMiddleware;
  hmrServer: WebSocketHMRServer;
  symbolicator: Symbolicator;

  constructor(config: DevServerConfig, private compiler: webpack.Compiler) {
    super(config, DevServer.getLoggerOptions(compiler, config.platform));

    this.wdm = devMiddleware(this.compiler, {
      mimeTypes: {
        bundle: 'text/javascript',
      },
    });

    this.hmrServer = new WebSocketHMRServer(this.fastify, {
      compiler: this.compiler,
    });

    this.symbolicator = new Symbolicator(
      this.compiler.context,
      this.fastify.log,
      async (fileUrl) => {
        const filename = getFilenameFromUrl(this.wdm.context, fileUrl);
        if (filename) {
          const fallbackSourceMapFilename = `${filename}.map`;
          const bundle = (await readFileFromWdm(this.wdm, filename)).toString();
          const [, sourceMappingUrl] = /sourceMappingURL=(.+)$/.exec(
            bundle
          ) || [undefined, undefined];
          const [sourceMapBasename] = sourceMappingUrl?.split('?') ?? [
            undefined,
          ];

          let sourceMapFilename = fallbackSourceMapFilename;
          if (sourceMapBasename) {
            sourceMapFilename = path.join(
              path.dirname(filename),
              sourceMapBasename
            );
          }

          try {
            const sourceMap = await readFileFromWdm(
              this.wdm,
              sourceMapFilename
            );
            return sourceMap.toString();
          } catch {
            this.fastify.log.warn({
              msg:
                'Failed to read source map from sourceMappingURL, trying fallback',
              sourceMappingUrl,
              sourceMapFilename,
            });
            const sourceMap = await readFileFromWdm(
              this.wdm,
              fallbackSourceMapFilename
            );
            return sourceMap.toString();
          }
        } else {
          throw new Error(`Cannot infer filename from url: ${fileUrl}`);
        }
      }
    );
  }

  async setup() {
    await this.fastify.register(fastifyExpress);

    this.fastify.use(this.wdm);

    await super.setup();

    this.fastify.post('/symbolicate', async (request, reply) => {
      try {
        const { stack } = JSON.parse(request.body as string) as {
          stack: ReactNativeStackFrame[];
        };
        const platform = Symbolicator.inferPlatformFromStack(stack);
        if (!platform) {
          reply.code(400).send();
        } else {
          const results = await this.symbolicator.process(stack);
          reply.send(results);
        }
      } catch (error) {
        this.fastify.log.error(error);
        reply.code(500).send();
      }
    });
  }

  async run() {
    try {
      await this.setup();
      await super.run();
    } catch (error) {
      this.fastify.log.error(error);
      process.exit(1);
    }
  }
}