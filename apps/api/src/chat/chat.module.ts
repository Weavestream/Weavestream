import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { ChatToolCallService } from './chat-tool-call.service.js';
import { AiModule } from '../ai/ai.module.js';
import { ArticlesModule } from '../articles/articles.module.js';

@Module({
  imports: [AiModule, ArticlesModule],
  controllers: [ChatController],
  providers: [ChatService, ChatStreamService, ChatToolCallService],
  exports: [ChatService],
})
export class ChatModule {}
