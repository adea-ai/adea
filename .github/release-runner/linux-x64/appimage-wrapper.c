#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  (void)argc;

  char executable[PATH_MAX];
  ssize_t length = readlink("/proc/self/exe", executable, sizeof(executable) - 1);
  if (length < 0) {
    fprintf(stderr, "appimage-wrapper: readlink failed: %s\n", strerror(errno));
    return 127;
  }
  executable[length] = '\0';

  char appdir[PATH_MAX];
  char apprun[PATH_MAX];
  if (snprintf(appdir, sizeof(appdir), "%s.extracted", executable) >= (int)sizeof(appdir) ||
      snprintf(apprun, sizeof(apprun), "%s/AppRun", appdir) >= (int)sizeof(apprun)) {
    fputs("appimage-wrapper: executable path is too long\n", stderr);
    return 127;
  }

  if (setenv("APPIMAGE", executable, 1) != 0 || setenv("APPDIR", appdir, 1) != 0) {
    fprintf(stderr, "appimage-wrapper: setenv failed: %s\n", strerror(errno));
    return 127;
  }

  execv(apprun, argv);
  fprintf(stderr, "appimage-wrapper: execv %s failed: %s\n", apprun, strerror(errno));
  return 127;
}
