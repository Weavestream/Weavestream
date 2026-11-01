const { TestEnvironment } = require('jest-environment-node');

/**
 * Node test environment that lets a spec change the process timezone.
 *
 * Inside a test, `process.env` is Jest's sandbox copy, so
 * `process.env.TZ = 'Asia/Tokyo'` there changes nothing: `Date` keeps the
 * machine zone. This environment runs outside the sandbox, where setting
 * `TZ` does reach V8. It exposes `setProcessTimeZone(tz)` to the spec and
 * restores the original zone on teardown, because the Jest worker runs
 * other spec files next.
 *
 * Opt in per spec file with the docblock
 * `@jest-environment <rootDir>/../jest.timezone-environment.js`.
 */
class TimezoneEnvironment extends TestEnvironment {
  async setup() {
    await super.setup();
    this.originalTz = process.env.TZ;
    this.global.setProcessTimeZone = (tz) => {
      process.env.TZ = tz;
    };
  }

  async teardown() {
    if (this.originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = this.originalTz;
    await super.teardown();
  }
}

module.exports = TimezoneEnvironment;
