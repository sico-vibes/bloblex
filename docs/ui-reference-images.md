# User UI reference images

The user supplied these seven screenshots on 1 October 2026 to explain rejected Bloblex behavior and desired Coucou fidelity. Exact PNG copies are kept here so a future session does not depend on temporary clipboard files. Root verified each copy's SHA-256 against its original. They are documentation/review references, not product assets or proof of the current Bloblex rendering.

The user's instruction controls the work: retain Coucou interaction behavior and rounded corners, full welcome wave, idle/typing/online/file states and mouth-free expressions; adapt to a bottom-center freely draggable floating bill. The plan retains original Bloblex circular art/provider palette and prohibits shipping protected Coucou/Mochi media. These screenshots are not authority to import the pictured character/assets into the product.

| User image | Saved reference | What it illustrates | SHA-256 |
| --- | --- | --- | --- |
| 1 | [Overview/activity](references/user-ui-feedback/01-overview-activity.png) | Focused agent activity and test result on the left, peer chips on the right; rounded rectangular cards. | `2FD390EF27ADEFAD2CB5E3E13D796D5EC514A97BA5A354B705D512B12C15B92B` |
| 2 | [Working badge](references/user-ui-feedback/02-working-badge.png) | Mouth-free face, two eyes and secondary working badge. | `8D4F57B330C4D2AC452E43DC4ADB3D7B04B948A438B5AC6F5F4A0797DDAA7E9B` |
| 3 | [Confused state](references/user-ui-feedback/03-confused-state.png) | Spiral eyes and temporary recovery copy following repeated interaction. | `46FDD6217AFB4863653A079AAD3C2BF6619F6613F62EAD2D6DB5ABA482E819D1` |
| 4 | [Happy expression](references/user-ui-feedback/04-happy-expression.png) | Happy eye curves without a mouth. | `357C9E48A319218F17AB4B06D24BE090D46D68F19E96CF022FFED174341DFA56` |
| 5 | [Welcome hands](references/user-ui-feedback/05-welcome-hands.png) | Centered welcome, detached low-left round dot and higher-right tilted oval; no human arms/fingers. | `031FC7ECB1E362B5E5F1A9CDF6C84A993243360F5250F8238B18D4721B0D5605` |
| 6 | [Overview navigation](references/user-ui-feedback/06-overview-navigation.png) | Home/chat/new navigation, settings/sound affordances, selected activity and peer overview. Pictured external service data is not a Bloblex fixture. | `DC38E8BE508CCD9B781167F9309E6EFBFA585D7A2A6B8D2988900C58F5BDA634` |
| 7 | [Rejected Bloblex pill](references/user-ui-feedback/07-rejected-bloblex-pill.png) | The earlier Claude/Online stadium-shaped row the user rejected; this is a negative reference. | `2C60348DAB536A34C80BE76C7B1C26B0979BD5E5F4DC0598E5CA06C539AD7F75` |

Original paths were `C:\Users\jbmst\AppData\Local\Temp\codex-clipboard-<id>.png`. IDs in user-image order:

```text
836a1fac-90f2-409a-a40a-e6bfbec18ff8
6843cae3-a475-49f5-a78c-e527eab86f63
e88fc0aa-fa02-4520-98f4-4c66c891b20b
7eaf6879-1997-4b50-9329-10bf1a361b83
1e6ca603-5112-4e46-9921-1b6ee19fa16c
2d93619d-6b69-49af-8864-0e65a3b8e3c2
25f587bc-ff7e-49c6-954a-21059804d354
```

Compare the references with [fidelity criteria](qa-ui-fidelity.md), [source mapping](companion-motion.md) and [independent QA evidence](qa-ui-execution.md). Final native observation remains required.

## Later launch-error evidence

The user then supplied [image 8: locked daemon build error](references/user-ui-feedback/08-launch-executable-lock.png), showing `npm run desktop:dev` failing to remove `target\debug\bloblexd.exe` with Windows error 5. This is diagnostic evidence, not a UI design reference. Original clipboard ID: `7571673f-e683-417b-87b9-bc78c34e44d8`; preserved-copy SHA-256: `5E2EFE4D580BFD45D3741F6B217202DB262038332E165AB41B83444EAF156A3E`. Root verified it against the original image. See the development guide and handoff for cause, fix and current verification state.
