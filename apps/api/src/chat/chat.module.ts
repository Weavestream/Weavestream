import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { ChatStreamService } from './chat-stream.service.js';
import { AiModule } from '../ai/ai.module.js';

@Module({
  imports: [AiModule],
  controllers: [ChatController],
  providers: [ChatService, ChatStreamService],
  exports: [ChatService],
})
export class ChatModule {}
