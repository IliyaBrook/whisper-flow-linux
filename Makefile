DEB := $(wildcard dist/wispr-flow_*.deb)
APPIMAGE := $(wildcard dist/Wispr_Flow-*-x86_64.AppImage)

.PHONY: build build-deb build-appimage download extract patch rebuild-native \
        test run run-debug clean install uninstall

build: build-deb

build-deb: download extract patch rebuild-native
	yarn run package-deb

build-appimage: download extract patch rebuild-native
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
	$(error No build found. Run 'make build' first)
endif
endif
ifdef APPIMAGE
	./$(APPIMAGE) --no-sandbox
else
	/opt/wispr-flow/wispr-flow --no-sandbox
endif

run-debug:
ifdef APPIMAGE
	ELECTRON_ENABLE_LOGGING=1 ./$(APPIMAGE) --no-sandbox --enable-logging
else
	ELECTRON_ENABLE_LOGGING=1 /opt/wispr-flow/wispr-flow --no-sandbox --enable-logging
endif

install:
ifndef DEB
	$(error No .deb found. Run 'make build' first)
endif
	sudo dpkg -i $(DEB)
	sudo apt-get install -f -y

uninstall:
	sudo dpkg -r wispr-flow

clean:
	rm -rf build/ dist/ tmp/
