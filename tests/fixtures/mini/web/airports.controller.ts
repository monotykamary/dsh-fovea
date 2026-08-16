// @ts-nocheck — fixture text: extractor parses this, tsc only lints
import { Controller, Get, Param, Query } from "@nestjs/common";

@Controller('api/airports')
export class AirportsController {
  @Get('search')
  search(@Query('q') q?: string): string[] {
    return q ? [q] : [];
  }

  @Get(':iata')
  find(@Param('iata') iata: string) {
    return { iata };
  }
}
