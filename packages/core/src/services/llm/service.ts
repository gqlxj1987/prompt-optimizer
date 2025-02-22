import { ILLMService, Message } from './types';
import { ModelConfig } from '../model/types';
import { ModelManager, modelManager as defaultModelManager } from '../model/manager';
import { ChatOpenAI } from '@langchain/openai';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from '@langchain/core/messages';
import { APIError, RequestConfigError, ERROR_MESSAGES } from './errors';

/**
 * LLM服务实现 - 基于 LangChain
 */
export class LLMService implements ILLMService {
  private modelInstances: Map<string, ChatOpenAI | ChatGoogleGenerativeAI> = new Map();

  constructor(private modelManager: ModelManager) {}

  /**
   * 验证消息格式
   */
  private validateMessages(messages: Message[]): void {
    if (!Array.isArray(messages)) {
      throw new RequestConfigError('消息必须是数组格式');
    }
    if (messages.length === 0) {
      throw new RequestConfigError('消息列表不能为空');
    }
    messages.forEach(msg => {
      if (!msg.role || !msg.content) {
        throw new RequestConfigError('消息格式无效: 缺少必要字段');
      }
      if (!['system', 'user', 'assistant'].includes(msg.role)) {
        throw new RequestConfigError(`不支持的消息类型: ${msg.role}`);
      }
      if (typeof msg.content !== 'string') {
        throw new RequestConfigError('消息内容必须是字符串');
      }
    });
  }

  /**
   * 验证模型配置
   */
  private validateModelConfig(modelConfig: ModelConfig): void {
    if (!modelConfig) {
      throw new RequestConfigError('模型配置不能为空');
    }
    if (!modelConfig.provider) {
      throw new RequestConfigError('模型提供商不能为空');
    }
    if (!modelConfig.apiKey) {
      throw new RequestConfigError(ERROR_MESSAGES.API_KEY_REQUIRED);
    }
    if (!modelConfig.defaultModel) {
      throw new RequestConfigError('默认模型不能为空');
    }
    if (!modelConfig.enabled) {
      throw new RequestConfigError('模型未启用');
    }
  }

  /**
   * 获取模型实例
   */
  private getModelInstance(modelConfig: ModelConfig): ChatOpenAI | ChatGoogleGenerativeAI {
    try {
      this.validateModelConfig(modelConfig);
      
      const cacheKey = `${modelConfig.provider}-${modelConfig.defaultModel}`;
      
      if (this.modelInstances.has(cacheKey)) {
        return this.modelInstances.get(cacheKey)!;
      }

      let model;
      if (modelConfig.provider === 'gemini') {
        model = new ChatGoogleGenerativeAI({
          apiKey: modelConfig.apiKey,
          modelName: modelConfig.defaultModel,
          maxOutputTokens: 2000,
          temperature: 0.7,
          streaming: true
        });
      } else {
        model = new ChatOpenAI({
          apiKey: modelConfig.apiKey,
          modelName: modelConfig.defaultModel,
          configuration: {
            apiKey: modelConfig.apiKey,
            baseURL: modelConfig.baseURL
          },
          temperature: 0.7,
          maxTokens: 2000,
          streaming: true
        });
      }
      this.modelInstances.set(cacheKey, model);
      return model;
    } catch (error: any) {
      if (error instanceof RequestConfigError) {
        throw error;
      }
      throw new APIError(`获取模型实例失败: ${error.message}`);
    }
  }

  /**
   * 将消息转换为 LangChain 格式
   */
  private convertToLangChainMessages(messages: Message[]): BaseMessage[] {
    try {
      this.validateMessages(messages);
      
      return messages.map(msg => {
        const content = msg.content;
        switch (msg.role) {
          case 'system':
            return new SystemMessage(content);
          case 'user':
            return new HumanMessage(content);
          case 'assistant':
            return new AIMessage(content);
          default:
            throw new RequestConfigError(`不支持的消息类型: ${msg.role}`);
        }
      });
    } catch (error: any) {
      if (error instanceof RequestConfigError) {
        throw error;
      }
      throw new APIError(`消息转换失败: ${error.message}`);
    }
  }

  /**
   * 发送消息
   */
  async sendMessage(messages: Message[], provider: string): Promise<string> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }

      const modelConfig = this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      this.validateModelConfig(modelConfig);
      this.validateMessages(messages);

      const model = this.getModelInstance(modelConfig);
      const langChainMessages = this.convertToLangChainMessages(messages);
      
      const response = await model.invoke(langChainMessages);
      return typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`发送消息失败: ${error.message}`);
    }
  }

  /**
   * 发送消息（流式）
   */
  async sendMessageStream(
    messages: Message[],
    provider: string,
    callbacks: {
      onToken: (token: string) => void;
      onComplete: () => void;
      onError: (error: Error) => void;
    }
  ): Promise<void> {
    try {
      console.log('开始流式请求:', { provider, messagesCount: messages.length });
      this.validateMessages(messages);
      
      const modelConfig = this.modelManager.getModel(provider);
      if (!modelConfig) {
        throw new RequestConfigError(`模型 ${provider} 不存在`);
      }

      const model = this.getModelInstance(modelConfig);
      console.log('获取到模型实例:', { 
        provider: modelConfig.provider,
        model: modelConfig.defaultModel 
      });
      
      // 转换消息格式
      const langchainMessages = messages.map(msg => {
        switch (msg.role) {
          case 'system':
            return new SystemMessage(msg.content);
          case 'user':
            return new HumanMessage(msg.content);
          case 'assistant':
            return new AIMessage(msg.content);
          default:
            throw new Error(`不支持的消息类型: ${msg.role}`);
        }
      });

      // 使用流式调用
      console.log('开始获取流式响应...');
      const stream = await model.stream(langchainMessages);
      console.log('成功获取到流式响应');
      
      try {
        for await (const chunk of stream) {
          if (chunk.content) {
            const content = typeof chunk.content === 'string' 
              ? chunk.content 
              : chunk.content.toString();
            
            console.log('收到数据块:', { 
              contentType: typeof chunk.content,
              contentLength: content.length,
              content: content.substring(0, 50) + '...' 
            });

            // 确保每个 token 都被正确处理
            await callbacks.onToken(content);
            // 添加小延迟，让 UI 有时间更新
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        console.log('流式响应完成');
        callbacks.onComplete();
      } catch (error) {
        console.error('流式处理过程中出错:', error);
        callbacks.onError(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } catch (error) {
      console.error('流式请求失败:', error);
      callbacks.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * 测试连接
   */
  async testConnection(provider: string): Promise<void> {
    try {
      if (!provider) {
        throw new RequestConfigError('模型提供商不能为空');
      }
      console.log('测试连接provider:', { 
        provider: provider,
      });
      // 发送一个简单的测试消息
      const testMessages: Message[] = [
        {
          role: 'user',
          content: '请回答ok'
        }
      ];

      // 使用 sendMessage 进行测试
      await this.sendMessage(testMessages, provider);

    } catch (error: any) {
      if (error instanceof RequestConfigError || error instanceof APIError) {
        throw error;
      }
      throw new APIError(`连接测试失败: ${error.message}`);
    }
  }
}

// 导出工厂函数
export function createLLMService(modelManager: ModelManager = defaultModelManager): LLMService {
  return new LLMService(modelManager);
} 