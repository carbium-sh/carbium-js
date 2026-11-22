#!/bin/sh
# Installs the carbium command line from a GitHub release of carbium-sh/carbium-js:
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/carbium-sh/carbium-js/main/packages/cli/install.sh | sh
#
# CARBIUM_VERSION        the version to install, for example 0.1.0 (default: the latest carbium on npm)
# CARBIUM_INSTALL        install root (default ~/.carbium); the binary goes to $CARBIUM_INSTALL/bin/carbium
# CARBIUM_DOWNLOAD_BASE  an https mirror of https://github.com/carbium-sh/carbium-js/releases/download
#
# The binary must match its line in the release's SHA256SUMS, or nothing is installed. The script never uses sudo,
# never edits a shell profile, never reads or writes keys or config, and sends nothing beyond its downloads.
# All of it runs from main on the last line, so a cut-off download runs nothing.
set -eu

say() { printf 'carbium-install: %s\n' "$*" >&2; }
die() {
	say "error: $*"
	exit 1
}
# downloaded text for a message: its first line, every byte outside printable ASCII shown as ?
clean() { printf '%s\n' "$1" | LC_ALL=C sed 's/[^ -~]/?/g;q'; }

# curl only: --proto '=https' also refuses a redirect to http, which GNU wget's --https-only does not
get() { curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"; }

sha256() {
	# from stdin: with a file name the tools escape a backslash in it and put one before the hash
	if [ "$sum" = sha256sum ]; then set -- "$(sha256sum <"$1")"; else set -- "$(shasum -a 256 <"$1")"; fi
	printf '%s\n' "${1%% *}"
}

target() {
	libc=
	case $(uname -m) in
	x86_64) arch=x64 gnu=/lib64/ld-linux-x86-64.so.2 musl=/lib/ld-musl-x86_64.so.1 ;;
	aarch64 | arm64) arch=arm64 gnu=/lib/ld-linux-aarch64.so.1 musl=/lib/ld-musl-aarch64.so.1 ;;
	*) die "no carbium binary for this CPU ($(uname -m)); npm install -g carbium works with Node 22.12+" ;;
	esac
	case $(uname -s) in
	Linux)
		# ldd names musl on Alpine and other musl systems; without ldd (busybox, distroless) the loader decides
		case $(ldd --version 2>&1 || :) in
		*musl*) libc=-musl ;;
		*) if [ -e "$gnu" ]; then :; elif [ -e "$musl" ]; then libc=-musl; else die "found neither glibc ($gnu) nor musl ($musl)"; fi ;;
		esac
		asset=carbium-linux-$arch$libc
		;;
	Darwin)
		# an x86_64 shell under Rosetta still gets the arm64 binary
		if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || :)" = 1 ]; then arch=arm64; fi
		asset=carbium-darwin-$arch
		;;
	MINGW* | MSYS* | CYGWIN*) die "on Windows take carbium-windows-$arch.exe from https://github.com/carbium-sh/carbium-js/releases, or npm install -g carbium" ;;
	*) die "no carbium binary for $(uname -s); npm install -g carbium works with Node 22.12+" ;;
	esac
}

# after a run that installed nothing: rmdir the folders this run made, deepest first; rmdir refuses one that holds anything
unmake() {
	d=$bin
	while [ -n "$made" ] && [ -n "$d" ]; do
		rmdir "$d" 2>/dev/null || :
		if [ "$d" = "$made" ]; then made=''; fi
		d=${d%/*}
	done
}

main() {
	base=${CARBIUM_DOWNLOAD_BASE:-https://github.com/carbium-sh/carbium-js/releases/download}
	base=${base%/}
	case $base in https://*) ;; *) die "CARBIUM_DOWNLOAD_BASE must be an https:// URL" ;; esac
	root=${CARBIUM_INSTALL:-${HOME:?HOME is not set}/.carbium}
	case $root in /*) ;; *) die "CARBIUM_INSTALL must be an absolute path" ;; esac
	case $root/ in */../*) die "CARBIUM_INSTALL must not contain .." ;; esac
	bin=$root/bin
	dest=$bin/carbium
	[ ! -e "$dest" ] || [ -f "$dest" ] || die "$dest exists and is not a file"
	target

	command -v curl >/dev/null 2>&1 || die "needs curl, for example: apk add curl, or apt-get install curl"
	case $(command -v curl) in */snap/*) die "a snap curl cannot write to $bin; install curl with your package manager" ;; esac
	if command -v sha256sum >/dev/null 2>&1; then
		sum=sha256sum
	elif command -v shasum >/dev/null 2>&1; then
		sum=shasum
	else
		die "needs sha256sum or shasum to check the download"
	fi

	made='' # the topmost folder this run creates
	d=$bin
	while [ -n "$d" ] && [ ! -e "$d" ]; do
		made=$d
		d=${d%/*}
	done
	tmp=''
	trap 'rm -rf ${tmp:+"$tmp"}; unmake' EXIT
	trap 'exit 1' HUP INT PIPE TERM
	mkdir -p "$bin" || die "cannot create $bin"
	tmp=$(mktemp -d "$bin/.carbium-install.XXXXXX") || die "cannot write to $bin"

	version=${CARBIUM_VERSION:-}
	if [ -z "$version" ]; then
		get https://registry.npmjs.org/-/package/carbium/dist-tags "$tmp/tags" ||
			die "cannot read the latest version from registry.npmjs.org; set CARBIUM_VERSION"
		version=$(sed -n 's/.*"latest" *: *"\([^"]*\)".*/\1/p' "$tmp/tags")
	fi
	version=${version#cli-v}
	version=${version#v}
	case $version in '' | *[!0-9A-Za-z.-]*) die "not a version: '$(clean "$version")'" ;; esac
	printf '%s\n' "$version" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' || die "not a version: $version"

	url=$base/cli-v$version
	say "installing carbium $version ($asset) from $url"
	get "$url/SHA256SUMS" "$tmp/SHA256SUMS" || die "cannot download $url/SHA256SUMS"
	want=$(awk -v f="$asset" '$2 == f || $2 == "*" f { n++; h = $1 }
		END { if (n == 1 && length(h) == 64 && h !~ /[^0-9a-f]/) print h }' "$tmp/SHA256SUMS")
	[ -n "$want" ] || die "SHA256SUMS of $version has no single valid line for $asset"
	get "$url/$asset" "$tmp/carbium" || die "cannot download $url/$asset"
	got=$(sha256 "$tmp/carbium")
	[ "$got" = "$want" ] || die "checksum mismatch for $asset: SHA256SUMS says $want, the download is $got"
	say "checksum ok: $got"
	chmod 755 "$tmp/carbium"
	ran=$("$tmp/carbium" --version </dev/null 2>&1) ||
		die "the downloaded binary does not run here: $(clean "$ran")${libc:+ (on Alpine: apk add libstdc++ libgcc)}"
	[ "$ran" = "$version" ] || die "the downloaded binary reports '$(clean "$ran")', not $version"
	mv -f "$tmp/carbium" "$dest"
	say "installed $dest"

	case :$PATH: in
	*:"$bin":*) ;;
	*)
		shown=$bin
		# shellcheck disable=SC2016 # $HOME and $PATH are printed for the user to paste
		if [ -n "${HOME:-}" ]; then case $bin in "$HOME"/*) shown='$HOME'${bin#"$HOME"} ;; esac; fi
		say "add it to your PATH, for example in ~/.profile or ~/.zshrc:"
		# shellcheck disable=SC2016
		printf '  export PATH="%s:$PATH"\n' "$shown" >&2
		;;
	esac
	first=$(command -v carbium 2>/dev/null || :)
	if [ -n "$first" ] && [ "$first" != "$dest" ]; then say "note: $first comes first on your PATH"; fi
	say "then run: carbium --help"
}

main "$@"
