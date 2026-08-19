import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { RecentCompaniesService } from './recent-companies.service.js';
import {
  CurrentUser,
  type AuthedUser,
} from '../common/current-user.decorator.js';
import { AuthedOnly } from '../rbac/require-permission.decorator.js';

/**
 * Last visited companies for the signed-in user — feeds the header
 * scope pill's switcher menu. Mounted under `/me/recent-companies` so
 * it sits alongside `/me/stars`. Uses `@AuthedOnly` because the
 * resource scope (the caller's own recents) is implicit; the service
 * applies a per-company access check on both read and write.
 *
 * Route shape:
 *   GET /me/recent-companies      → { items: [{ id, name }] } in recency order
 *   PUT /me/recent-companies/:id  → record a visit (204)
 *
 * No audit rows: recording page navigation is routine traffic, not an
 * audit-relevant action.
 */
@Controller({ path: 'me/recent-companies', version: '1' })
@AuthedOnly()
export class RecentCompaniesController {
  constructor(private readonly recents: RecentCompaniesService) {}

  @Get()
  async list(@CurrentUser() user: AuthedUser) {
    return this.recents.list(user);
  }

  @Put(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async record(
    @CurrentUser() user: AuthedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.recents.record(user, id);
  }
}
