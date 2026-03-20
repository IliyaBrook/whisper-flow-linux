DEB := $(firstword $(wildcard dist/wispr-flow_*.deb))
APPIMAGE := $(firstword $(wildcard dist/Wispr_Flow-*-x86_64.AppImage))

.PHONY: build build-deb build-appimage rebuild download extract patch rebuild-native \
        test run run-debug clean install uninstall check-runtime-deps

build: build-deb

build-deb: download extract patch rebuild-native
	yarn run package-deb

build-appimage: check-runtime-deps download extract patch rebuild-native
	yarn run package-appimage

check-runtime-deps:
	chmod +x scripts/runtime-deps.sh
	./scripts/runtime-deps.sh check

# Full rebuild after code changes (scripts/ or linux-helper/).
# Re-extracts clean bundle, re-applies patches, repackages AppImage.
# Skips download and rebuild-native (cached, rarely change).
rebuild:
	@pgrep -f '[W]ispr.Flow' | xargs -r kill 2>/dev/null || true
	@pgrep -f '[w]ispr-flow' --full | grep -v make | xargs -r kill 2>/dev/null || true
	@sleep 0.5
	yarn run extract
	yarn run patch
	yarn run rebuild-native
	yarn run package-appimage

download:
	yarn run download

extract:
	yarn run extract

patch:
	yarn run patch

rebuild-native:
	yarn run rebuild-native

test:
	yarn run test

run:
ifndef DEB
ifndef APPIMAGE
	$(error No build found. Run 'make build' or 'make build-appimage' first)
endif
endif
ifdef APPIMAGE
	./$(APPIMAGE)
else
	/opt/wispr-flow/wispr-flow --no-sandbox
endif

run-debug:
ifdef APPIMAGE
	WISPR_DEBUG=1 ./$(APPIMAGE)
else
	WISPR_DEBUG=1 ELECTRON_ENABLE_LOGGING=1 ELECTRON_USE_SYSTEM_TITLE_BAR=1 /opt/wispr-flow/wispr-flow --no-sandbox --disable-features=CustomTitlebar --enable-logging
endif

install:
ifndef DEB
ifndef APPIMAGE
	$(error No build found. Run 'make build' or 'make build-appimage' first)
endif
endif
	chmod +x scripts/install-deb.sh
	./scripts/install-deb.sh "$(DEB)" "$(APPIMAGE)"

uninstall:
	sudo dpkg -r wispr-flow

clean:
	rm -rf build/ dist/ tmp/
