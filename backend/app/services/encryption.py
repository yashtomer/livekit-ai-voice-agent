from cryptography.fernet import Fernet
from ..config import FERNET_KEY

_key = FERNET_KEY.encode() if isinstance(FERNET_KEY, str) else FERNET_KEY
_fernet = Fernet(_key)


def encrypt_key(plaintext: str) -> bytes:
    return _fernet.encrypt(plaintext.encode("utf-8"))


def decrypt_key(ciphertext: bytes) -> str:
    return _fernet.decrypt(ciphertext).decode("utf-8")
