import { Injectable } from '@nestjs/common';
import type { FieldType } from '@weavestream/shared';
import type { FieldTypeStrategy } from './field-type-strategy.js';
import { TextStrategy, TextareaStrategy } from './strategies/text.strategy.js';
import { RichTextStrategy } from './strategies/rich-text.strategy.js';
import { NumberStrategy } from './strategies/number.strategy.js';
import { DateStrategy, DateTimeStrategy } from './strategies/date.strategy.js';
import { BooleanStrategy } from './strategies/boolean.strategy.js';
import {
  DropdownStrategy,
  MultiselectStrategy,
} from './strategies/choice.strategy.js';
import {
  EmailStrategy,
  PhoneStrategy,
  UrlStrategy,
  VaultwardenLinkStrategy,
} from './strategies/contact.strategy.js';
import { AssetReferenceStrategy } from './strategies/asset-reference.strategy.js';
import { FileStrategy, TagsStrategy } from './strategies/file.strategy.js';
import { IpAddressStrategy } from './strategies/ip-address.strategy.js';

/**
 * Single place that wires every FieldType to its strategy implementation.
 * Callers (AssetsService, AssetLayoutsService) consult the registry via
 * `get(kind)`; missing entries throw at startup (unit test asserts the
 * mapping is exhaustive). No DI between strategies — each is a simple
 * class without its own dependencies, which keeps unit testing trivial.
 */
@Injectable()
export class FieldTypesRegistry {
  private readonly byKind: Map<FieldType, FieldTypeStrategy>;

  constructor() {
    const strategies: FieldTypeStrategy[] = [
      new TextStrategy(),
      new TextareaStrategy(),
      new RichTextStrategy(),
      new NumberStrategy(),
      new DateStrategy(),
      new DateTimeStrategy(),
      new BooleanStrategy(),
      new DropdownStrategy(),
      new MultiselectStrategy(),
      new EmailStrategy(),
      new PhoneStrategy(),
      new UrlStrategy(),
      new AssetReferenceStrategy(),
      new VaultwardenLinkStrategy(),
      new FileStrategy(),
      new TagsStrategy(),
      new IpAddressStrategy(),
    ];
    this.byKind = new Map(strategies.map((s) => [s.kind, s]));
  }

  get(kind: FieldType): FieldTypeStrategy {
    const s = this.byKind.get(kind);
    if (!s) {
      throw new Error(`FieldTypesRegistry: no strategy registered for ${kind}`);
    }
    return s;
  }

  all(): FieldTypeStrategy[] {
    return [...this.byKind.values()];
  }
}
