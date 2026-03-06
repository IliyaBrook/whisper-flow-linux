DEB := $(wildcard dist/wispr-flow_*.deb)
APPIMAGE := $(wildcard dist/Wispr_Flow-*-x86_64.AppImage)

.PHONY: build build-deb build-appimage download extract patch rebuild-native \
        test run run-debug clean install uninstall

build: build-deb

build-deb: download extract patch rebuild-native
	yarn package-deb

build-appimage: download extract patch rebuild-native
	yarn package-appimage

download:
	yarn download

extract:
	yarn extract

patch:
	yarn patch

rebuild-native:
	yarn rebuild-native

test:
	yarn test

run:
ifndef DEB
ifndef APPIMAGE
	$(error No build found. Run 'make build' first)
endif
endif
ifdef APPIMAGE
	./$(APPIMAGE)
else
	/opt/wispr-flow/wispr-flow
endif

run-debug:
ifdef APPIMAGE
	ELECTRON_ENABLE_LOGGING=1 ./$(APPIMAGE) --enable-logging
else
	ELECTRON_ENABLE_LOGGING=1 /opt/wispr-flow/wispr-flow --enable-logging
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
